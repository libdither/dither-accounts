/** The manager as a library: main.ts runs it, tests make one on a temp dir and port. */
import { join, resolve } from 'node:path';
import { Approvers } from './approvers.ts';
import { Store } from './db.ts';
import { Http } from './http.ts';
import { type Kind, loadKinds } from './kinds.ts';
import { type NoticeTimes, Notices, NOTICES_KIND, noticesKind } from './notices.ts';
import { providers as factories, type Provider } from './providers/index.ts';
import { Router } from './router.ts';
import { Supervisor } from './supervisor.ts';
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
  /** Tests only: the manager's notices' hold times, debounce and sweep (notices.ts NOTICE_TIMES). */
  noticeTimes?: Partial<NoticeTimes>;
}

export interface Manager {
  store: Store;
  router: Router;
  sup: Supervisor;
  http: Http;
  approvers: Approvers;
  notices: Notices;
  kinds: Map<string, Kind>;
  providers: Provider[];
  url: string;
  stop(): Promise<void>;
}

export async function createManager(o: ManagerOpts): Promise<Manager> {
  const repoRoot = o.repoRoot ?? resolve(import.meta.dir, '../../..');
  const traceFile = o.trace ? new NdjsonFile(join(o.dataDir, 'traces/manager.trace.ndjson')) : null;
  const stallFile = o.trace ? new NdjsonFile(join(o.dataDir, 'traces/event-loop-stalls.ndjson'), { maxBytes: 2 * 1024 * 1024, keep: 3 }) : null;
  if (traceFile) setTraceSink(traceFile.push);
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
    onEvent: (id, ev) => {
      router.event(id, ev);
      if (ev.t === 'status') notices?.poke();
    },
    onChange: () => {
      router?.accountsChanged();
      notices?.poke();
    },
    onCrash: (id) => notices?.crashed(id),
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
  http.start();
  if (o.startAccounts !== false) sup.startAll();
  return {
    store,
    router,
    sup,
    http,
    approvers,
    notices,
    kinds,
    providers,
    url: `http://127.0.0.1:${http.server.port}`,
    async stop() {
      for (const p of providers) p.stop?.();
      notices!.stop();
      await sup.stopAll();
      approvers.stop();
      router.stop();
      http.stop();
      store.db.close();
      stalls?.stop();
      if (traceFile) setTraceSink(null);
      traceFile?.close();
      stallFile?.close();
    },
  };
}

export type { Kind, Manifest } from './kinds.ts';
export { kindOf, loadKinds } from './kinds.ts';
export { acquireLock, releaseLock, LOCK } from './supervisor.ts';
