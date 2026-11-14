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
import { chooseLaunch, type Launch, Supervisor } from './supervisor.ts';
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
  /**
   * Stops the manager. With `leaveExtractors`, extractors that can outlive it are left running for the next manager
   * to adopt (main.ts on SIGTERM: a restart keeps every session); without it every extractor stops.
   */
  stop(o?: { leaveExtractors?: boolean }): Promise<void>;
}

export async function createManager(o: ManagerOpts): Promise<Manager> {
  const repoRoot = o.repoRoot ?? resolve(import.meta.dir, '../../..');
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
  const sup = new Supervisor(store, kinds, {
    extractorUrl: () => `ws://127.0.0.1:${http.server.port}/extractor`,
    repoRoot,
    dataDir: o.dataDir,
    launch: chooseLaunch(o.launch ?? 'child'),
    fingerprint: o.fingerprint,
    restartPauseMs: o.restartPauseMs,
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
    // The approver's questions, for kinds that hold passkeys; the manager names the account itself.
    onAsk: async (id, what, input) => {
      const a = store.account(id);
      if (!a || !kinds.get(a.kind)?.passkeys) throw new Error('this account holds no passkeys');
      if (what === 'approver.request') return approvers.request(a, input);
      throw new Error(`the manager answers no "${what}"`);
    },
  });
  router = new Router(store, kinds, sup, { dataDir: o.dataDir });
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
  http.notices = notices;
  http.start();
  if (o.startAccounts !== false) sup.startAll();
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
    async stop(so = {}) {
      for (const p of providers) p.stop?.();
      notices!.stop();
      await sup.stopAll({ leave: so.leaveExtractors === true });
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

export type { Kind, Manifest } from './kinds.ts';
export { kindOf, loadKinds } from './kinds.ts';
export { acquireLock, releaseLock, LOCK, type Launch } from './supervisor.ts';
