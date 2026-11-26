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
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BinsInfo } from './api-types.ts';

export const BINS_DIR = 'bins';

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
  attr?: 'dither-bins' | 'dither-test-bins';
  log?: (level: 'info' | 'warn', msg: string) => void;
  /** The nix-build to run (tests give a stand-in). */
  nixBuild?: string;
  timeoutMs?: number;
}): Promise<PrepareResult> {
  const t0 = Date.now();
  const out = o.out ?? join(o.dataDir!, BINS_DIR);
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
    o.log?.('warn', `prepare: the sandboxes' programs were not built (${why})${kept() ? '; the last ones stay' : ''}`);
    return { dir: kept(), why, ms };
  }
  o.log?.('info', `prepare: the sandboxes' programs are ready in ${out} (${stdout.trim().split('\n').pop()}, ${ms} ms)`);
  return { dir: out, ms };
}

/** How preparing the sandboxes' programs stands, for the manager's page (ManagerState.bins). */
export type BinsState = BinsInfo;

/**
 * prepareBins kept at: a failed build is tried again in the background, 30 s later, then twice as long after each
 * failure, up to 30 min, until one succeeds. `ready` resolves once kinds with a screen can start: the programs built,
 * or an earlier out-link kept while the build fails, or no nix-build here. With neither (the very first build failing)
 * it waits, and they start once a later try succeeds; meanwhile the manager's page says so (state).
 */
export class KeptBins {
  state: BinsState = { state: 'preparing', dir: null, why: null, tries: 0, retryAt: null };
  readonly ready: Promise<void>;
  private settle!: () => void;
  private timer?: Timer;
  private stopped = false;
  private wait: number;

  constructor(
    private o: Omit<Parameters<typeof prepareBins>[0], 'out' | 'attr'> & {
      /** The state changed (the page shows it). */
      onChange?: (s: BinsState) => void;
      /** The first wait before trying again (30 s; tests make it short), and the longest (30 min). */
      firstRetryMs?: number;
      maxRetryMs?: number;
    },
  ) {
    this.ready = new Promise((r) => (this.settle = r));
    this.wait = o.firstRetryMs ?? 30_000;
    void this.attempt();
  }

  dir(): string | null {
    return this.state.dir;
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
    const r = await prepareBins(this.o);
    if (this.stopped) return;
    const tries = this.state.tries + 1;
    if (!r.why) {
      this.set({ state: 'ready', dir: r.dir, why: null, tries, retryAt: null });
      return this.settle();
    }
    if (r.why === 'no nix-build') {
      this.set({ state: 'none', dir: r.dir, why: r.why, tries, retryAt: null });
      return this.settle();
    }
    const wait = this.wait;
    this.wait = Math.min(wait * 2, this.o.maxRetryMs ?? 30 * 60_000);
    this.o.log?.('warn', `prepare: trying again in ${wait < 1000 ? `${wait} ms` : `${Math.round(wait / 1000)} s`}${r.dir ? '' : "; kinds with a screen wait for it, since there are no earlier ones"}`);
    this.set({ state: 'failing', dir: r.dir, why: r.why, tries, retryAt: Date.now() + wait });
    // With the last good ones kept, kinds with a screen run on those meanwhile.
    if (r.dir) this.settle();
    this.timer = setTimeout(() => void this.attempt(), wait);
  }
}
