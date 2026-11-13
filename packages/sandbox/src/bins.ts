/**
 * Programs the sandbox runs, found as packages/browser finds its own: an environment override, then PATH, then known
 * places, then `nix build nixpkgs#<attr>`. Results are resolved to their real /nix/store path, because inside the
 * sandbox only /nix/store is there (a /run/current-system symlink would point nowhere).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface BinSpec {
  /** The executable's file name (on PATH and in the nix output's bin/). */
  name: string;
  /** Environment variable that overrides it with a path. */
  env: string;
  /** nixpkgs attribute to build when nothing else has it. */
  nix: string;
  candidates?: string[];
}

const cache = new Map<string, string>();

/**
 * Follow symlinks only until the path is in /nix/store, keeping the last name: a multi-call program (ImageMagick's
 * import, pasta → passt, coreutils' env) acts by the name it is run as, and inside the store every link still works.
 */
const real = (p: string) => {
  let cur = p;
  for (let i = 0; i < 40 && !cur.startsWith('/nix/store/'); i++) {
    try {
      if (!lstatSync(cur).isSymbolicLink()) return realpathSync(cur);
      cur = resolve(dirname(cur), readlinkSync(cur));
    } catch {
      return p;
    }
  }
  return cur;
};

/** A binary's real path, or throws saying how to provide it. */
export function resolveBin(spec: BinSpec, log: Log): string {
  const hit = cache.get(spec.name);
  if (hit && existsSync(hit)) return hit;
  const found = (() => {
    const fromEnv = process.env[spec.env];
    if (fromEnv && existsSync(fromEnv)) return real(fromEnv);
    const onPath = Bun.which(spec.name);
    if (onPath) return real(onPath);
    for (const c of spec.candidates ?? []) if (existsSync(c)) return real(c);
    log('info', `resolving ${spec.name} via nix build nixpkgs#${spec.nix}`);
    const out = spawnSync('nix', ['build', `nixpkgs#${spec.nix}`, '--no-link', '--print-out-paths'], { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`cannot find ${spec.name}: set ${spec.env}, put it on PATH, or make nix available (${(out.stderr ?? out.error?.message ?? '').slice(0, 200)})`);
    for (const store of out.stdout.trim().split('\n').reverse()) {
      const bin = join(store.trim(), 'bin', spec.name);
      if (existsSync(bin)) return bin;
    }
    throw new Error(`nix built ${spec.nix} but it has no bin/${spec.name}`);
  })();
  cache.set(spec.name, found);
  return found;
}

/** The same, or null when it cannot be had (for what the sandbox can do without). */
export function tryBin(spec: BinSpec, log: Log): string | null {
  try {
    return resolveBin(spec, log);
  } catch (e) {
    log('info', `${spec.name} unavailable: ${(e as Error).message}`);
    return null;
  }
}

export const BINS = {
  xvfb: { name: 'Xvfb', env: 'XVFB_BIN', nix: 'xvfb' },
  x11vnc: { name: 'x11vnc', env: 'X11VNC_BIN', nix: 'x11vnc' },
  bwrap: { name: 'bwrap', env: 'BWRAP_BIN', nix: 'bubblewrap' },
  pasta: { name: 'pasta', env: 'PASTA_BIN', nix: 'passt' },
  dbusDaemon: { name: 'dbus-daemon', env: 'DBUS_DAEMON_BIN', nix: 'dbus', candidates: ['/run/current-system/sw/bin/dbus-daemon'] },
  xdotool: { name: 'xdotool', env: 'XDOTOOL_BIN', nix: 'xdotool' },
  sh: { name: 'sh', env: 'SANDBOX_SH_BIN', nix: 'bash', candidates: ['/bin/sh'] },
  env: { name: 'env', env: 'SANDBOX_COREUTILS_ENV', nix: 'coreutils', candidates: ['/usr/bin/env'] },
} satisfies Record<string, BinSpec>;

export interface SandboxBins {
  xvfb: string;
  x11vnc: string;
  bwrap: string;
  dbusDaemon: string;
  /** dbus-send from the same package as dbus-daemon: what the shims call. */
  dbusSend: string;
  sh: string;
  /** coreutils' bin directory: the sandbox's PATH after the shims. */
  coreutils: string;
  pasta: string | null;
  xdotool: string | null;
}

export function sandboxBins(log: Log, want: { pasta: boolean; xdotool: boolean }): SandboxBins {
  const dbusDaemon = resolveBin(BINS.dbusDaemon, log);
  const dbusSend = join(dirname(dbusDaemon), 'dbus-send');
  if (!existsSync(dbusSend)) throw new Error(`${dirname(dbusDaemon)} has dbus-daemon but no dbus-send`);
  const sh = resolveBin(BINS.sh, log);
  const env = resolveBin(BINS.env, log);
  for (const [name, p] of Object.entries({ 'dbus-daemon': dbusDaemon, sh, env })) {
    if (!p.startsWith('/nix/store/')) throw new Error(`${name} is ${p}, outside /nix/store, so the sandbox cannot run it`);
  }
  return {
    xvfb: resolveBin(BINS.xvfb, log),
    x11vnc: resolveBin(BINS.x11vnc, log),
    bwrap: resolveBin(BINS.bwrap, log),
    dbusDaemon,
    dbusSend,
    sh,
    coreutils: dirname(env),
    pasta: want.pasta ? tryBin(BINS.pasta, log) : null,
    xdotool: want.xdotool ? tryBin(BINS.xdotool, log) : null,
  };
}
