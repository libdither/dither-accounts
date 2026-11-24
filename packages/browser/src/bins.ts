/**
 * Programs the sandboxes run, found the same way everywhere: an environment override, then PATH (unless the spec says
 * PATH's copy is the wrong one), then known places, then `nix build nixpkgs#<attr>`. Results are resolved to their real
 * /nix/store path, because inside a bubblewrap sandbox only /nix/store is there (a /run/current-system symlink would
 * point nowhere). packages/sandbox re-exports these.
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
  /** False when the copy on PATH is not the one to run (NixOS's sway is wrapped in dbus-run-session). Default true. */
  path?: boolean;
  /** The directory of the nix output it is in, when not bin/ (portals live in libexec/). */
  sub?: string;
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
  const key = `${spec.name}\0${spec.nix}`;
  const hit = cache.get(key);
  if (hit && existsSync(hit)) return hit;
  const found = (() => {
    const fromEnv = process.env[spec.env];
    if (fromEnv && existsSync(fromEnv)) return real(fromEnv);
    const onPath = spec.path === false ? null : Bun.which(spec.name);
    if (onPath) return real(onPath);
    for (const c of spec.candidates ?? []) if (existsSync(c)) return real(c);
    log('info', `resolving ${spec.name} via nix build nixpkgs#${spec.nix}`);
    const out = spawnSync('nix', ['build', `nixpkgs#${spec.nix}`, '--no-link', '--print-out-paths'], { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`cannot find ${spec.name}: set ${spec.env}, put it on PATH, or make nix available (${(out.stderr ?? out.error?.message ?? '').slice(0, 200)})`);
    for (const store of out.stdout.trim().split('\n').reverse()) {
      const bin = join(store.trim(), spec.sub ?? 'bin', spec.name);
      if (existsSync(bin)) return bin;
    }
    throw new Error(`nix built ${spec.nix} but it has no ${spec.sub ?? 'bin'}/${spec.name}`);
  })();
  cache.set(key, found);
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

/** The display backends' programs (screen.ts). */
export const DISPLAY_BINS = {
  xvfb: { name: 'Xvfb', env: 'XVFB_BIN', nix: 'xvfb' },
  x11vnc: { name: 'x11vnc', env: 'X11VNC_BIN', nix: 'x11vnc' },
  xdotool: { name: 'xdotool', env: 'XDOTOOL_BIN', nix: 'xdotool' },
  import: { name: 'import', env: 'IMPORT_BIN', nix: 'imagemagick' },
  // sway-unwrapped: NixOS's `sway` runs it under dbus-run-session, a session bus of its own we neither want nor stop.
  sway: { name: 'sway', env: 'SWAY_BIN', nix: 'sway-unwrapped', path: false },
  wayvnc: { name: 'wayvnc', env: 'WAYVNC_BIN', nix: 'wayvnc' },
  grim: { name: 'grim', env: 'GRIM_BIN', nix: 'grim' },
} satisfies Record<string, BinSpec>;

/** Run a program, collect its stdout; reject with its stderr when it fails. */
export function run(cmd: string[], env: Record<string, string | undefined>, what: string, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = Bun.spawn(cmd, { env: cleanEnv(env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    void Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => {
      if (code === 0) resolve(Buffer.from(out));
      else reject(new Error(`${what} failed: ${err.trim().slice(0, 200) || `${cmd[0]?.split('/').pop()} exited ${code}`}`));
    }, reject);
  });
}

/** Without these an environment keeps whatever display the manager's own had. */
export const withoutDisplays = (env: Record<string, string | undefined>) => {
  const e = { ...env };
  delete e.DISPLAY;
  delete e.WAYLAND_DISPLAY;
  delete e.WAYLAND_SOCKET;
  return e;
};

/** An environment for Bun.spawn: a key set to undefined is left out (so it can remove what it would inherit). */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
