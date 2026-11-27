/**
 * The sandboxes' programs, prepared ahead of time from the repo's one pinned nixpkgs (nix/README.md): Xvfb, x11vnc,
 * sway, wayvnc, the screen share's PipeWire and portals, bubblewrap and the rest of nix/bins.json's `run` list. At its
 * start the manager builds `nix-build <repo>/nix -A dither-bins -o <data>/bins`: one out-link, a link per package
 * inside, and a GC root for all of them, so a garbage collection never takes a program a sandbox is about to run.
 * Its extractors of a kind with a screen wait for it (supervisor.ts) and get the directory as DITHER_BINS, where
 * packages/browser's resolveBin looks first. Nothing in an extractor builds anything.
 *
 * Asynchronous, so the manager answers meanwhile; on a machine with the packages already in its store it takes a few
 * seconds (evaluating nixpkgs). A machine without nix-build skips it: the sandboxes find their programs on PATH there.
 * A failed build keeps the last good out-link, if there is one, and is tried again in the background (KeptBins).
 *
 * The servers built from forks this project keeps (bins.json `forks`: KasmVNC, w0vncserver) are a second build,
 * `-A dither-bins-forks -o <data>/bins-forks`, with its own out-link and state. It starts after the first is ready, and
 * only once a backend that needs it is in use (an account starting on one, or one picked on the page): where no cache
 * has them they build from source for minutes, and one failing to build leaves every other backend as it was. Those
 * accounts get both directories (DITHER_BINS is a list) and wait for both.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BinsInfo } from './api-types.ts';

export const BINS_DIR = 'bins';
/** The forks' servers' out-link, beside it. */
export const FORK_BINS_DIR = 'bins-forks';

/** What is built: the sandboxes' programs, those and the tests' (scripts/prepare-bins.ts), or the forks' servers. */
export type BinsAttr = 'dither-bins' | 'dither-test-bins' | 'dither-bins-forks';

export interface PrepareResult {
  /** The prepared directory (DITHER_BINS), or null when there is none to give. */
  dir: string | null;
  /** Why it was not built now (no nix-build, a failed build), when it was not. */
  why?: string;
  ms: number;
}

/**
 * Build the pinned programs into `<dataDir>/bins` (or `out`). `attr` is dither-bins, or dither-test-bins for the
 * tests' programs too. Never throws: a failure is in `why`, and the earlier out-link stays.
 */
export async function prepareBins(o: {
  repoRoot: string;
  dataDir?: string;
  out?: string;
  attr?: BinsAttr;
  log?: (level: 'info' | 'warn', msg: string) => void;
  /** The nix-build to run (tests give a stand-in). */
  nixBuild?: string;
  timeoutMs?: number;
}): Promise<PrepareResult> {
  const t0 = Date.now();
  const out = o.out ?? join(o.dataDir!, o.attr === 'dither-bins-forks' ? FORK_BINS_DIR : BINS_DIR);
  const kept = () => (existsSync(out) ? out : null);
  const nixBuild = o.nixBuild ?? Bun.which('nix-build', { PATH: process.env.PATH ?? '' });
  if (!nixBuild) {
    o.log?.('info', 'prepare: no nix-build here, so the sandboxes find their programs on PATH');
    return { dir: kept(), why: 'no nix-build', ms: Date.now() - t0 };
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const p = Bun.spawn([nixBuild, join(o.repoRoot, 'nix'), '-A', o.attr ?? 'dither-bins', '-o', out], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: o.timeoutMs ?? 30 * 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const ms = Date.now() - t0;
  if (code !== 0 || !existsSync(out)) {
    const why = `nix-build exited ${p.signalCode ?? code}: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`;
    o.log?.('warn', `prepare: ${what(o.attr)} were not built (${why})${kept() ? '; the last ones stay' : ''}`);
    return { dir: kept(), why, ms };
  }
  o.log?.('info', `prepare: ${what(o.attr)} are ready in ${out} (${stdout.trim().split('\n').pop()}, ${ms} ms)`);
  return { dir: out, ms };
}

const what = (attr?: BinsAttr) => (attr === 'dither-bins-forks' ? "the forks' servers" : "the sandboxes' programs");

/** How preparing the sandboxes' programs stands, for the manager's page (ManagerState.bins). */
export type BinsState = BinsInfo;

/**
 * prepareBins kept at: a failed build is tried again in the background, 30 s later, then twice as long after each
 * failure, up to 30 min, until one succeeds. `ready` resolves once kinds with a screen can start: the programs built,
 * or an earlier out-link kept while the build fails, or no nix-build here. With neither (the very first build failing)
 * it waits, and they start once a later try succeeds; meanwhile the manager's page says so (state).
 *
 * `lazy`: nothing is built until start() (state `idle` until then), and then only once `after` has settled (the forks'
 * build waits for the first). `tried` resolves once the first try has ended, however it went.
 */
export class KeptBins {
  state: BinsState;
  readonly ready: Promise<void>;
  readonly tried: Promise<void>;
  private settle!: () => void;
  private settleTried!: () => void;
  private started = false;
  private timer?: Timer;
  private stopped = false;
  private wait: number;

  constructor(
    private o: Omit<Parameters<typeof prepareBins>[0], 'out' | 'attr'> & {
      /** dither-bins (the default), or dither-bins-forks; each has its own out-link in the data directory. */
      attr?: 'dither-bins' | 'dither-bins-forks';
      /** Built only once start() is called, after `after` settles. */
      lazy?: boolean;
      after?: Promise<unknown>;
      /** The state changed (the page shows it). */
      onChange?: (s: BinsState) => void;
      /** The first wait before trying again (30 s; tests make it short), and the longest (30 min). */
      firstRetryMs?: number;
      maxRetryMs?: number;
    },
  ) {
    this.ready = new Promise((r) => (this.settle = r));
    this.tried = new Promise((r) => (this.settleTried = r));
    this.wait = o.firstRetryMs ?? 30_000;
    this.state = { state: o.lazy ? 'idle' : 'preparing', dir: null, why: null, tries: 0, retryAt: null };
    if (!o.lazy) this.start();
  }

  /** Build them, if that has not started yet (after `after`). */
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.state.state === 'idle') this.set({ state: 'preparing' });
    void Promise.resolve(this.o.after)
      .catch(() => {})
      .then(() => this.attempt());
  }

  dir(): string | null {
    return this.state.dir;
  }

  /** What `ready` says: built, an earlier build kept, or none to build here (programs from PATH). */
  usable(): boolean {
    const st = this.state.state;
    return st === 'ready' || st === 'none' || (st === 'failing' && !!this.state.dir);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private set(s: Partial<BinsState>) {
    this.state = { ...this.state, ...s };
    this.o.onChange?.(this.state);
  }

  private async attempt() {
    if (this.stopped) return;
    const r = await prepareBins({ ...this.o, attr: this.o.attr ?? 'dither-bins' });
    if (this.stopped) return;
    const tries = this.state.tries + 1;
    if (!r.why) {
      this.set({ state: 'ready', dir: r.dir, why: null, tries, retryAt: null });
      this.settleTried();
      return this.settle();
    }
    if (r.why === 'no nix-build') {
      this.set({ state: 'none', dir: r.dir, why: r.why, tries, retryAt: null });
      this.settleTried();
      return this.settle();
    }
    const wait = this.wait;
    this.wait = Math.min(wait * 2, this.o.maxRetryMs ?? 30 * 60_000);
    this.o.log?.('warn', `prepare: trying again in ${wait < 1000 ? `${wait} ms` : `${Math.round(wait / 1000)} s`}${r.dir ? '' : this.o.attr === 'dither-bins-forks' ? '; accounts on a backend that needs them wait for it, since there are no earlier ones' : '; kinds with a screen wait for it, since there are no earlier ones'}`);
    this.set({ state: 'failing', dir: r.dir, why: r.why, tries, retryAt: Date.now() + wait });
    this.settleTried();
    // With the last good ones kept, kinds with a screen run on those meanwhile.
    if (r.dir) this.settle();
    this.timer = setTimeout(() => void this.attempt(), wait);
  }
}
