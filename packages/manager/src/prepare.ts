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
 * A failed build keeps the last good out-link, if there is one.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
