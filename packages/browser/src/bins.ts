/**
 * Programs the sandboxes run, found the same way everywhere. Results are resolved to their real /nix/store path,
 * because inside a bubblewrap sandbox only /nix/store is there (a /run/current-system symlink would point nowhere).
 * packages/sandbox re-exports these.
 *
 * A pinned program (the screens', the screen share's and the native sandbox's: `pinned: true`) comes from the repo's
 * one nixpkgs (nix/pin.json), prepared ahead of time: the manager builds them at its start (packages/manager
 * prepare.ts, `nix-build nix -A dither-bins`) into an out-link in its data directory, which is their GC root, and hands
 * the directory to its extractors as DITHER_BINS; CI and the tests run `bun scripts/prepare-bins.ts`. In order:
 *
 *   1. its environment override (SWAY_BIN …)
 *   2. DITHER_BINS/<attr>, the prepared package
 *   3. PATH (unless the spec says PATH's copy is the wrong one), then known places: a machine without Nix
 *   4. none: an error at once saying how to prepare it. An extractor never runs `nix build` for one, and never waits.
 *
 * Anything else (an app a native sandbox runs: Signal Desktop, Telegram Desktop) is found by 1 and 3, then, as before
 * the pin, `nix build nixpkgs#<attr>` from the machine's own nixpkgs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DisplayBackend } from '@dither-accounts/spec/display';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface BinSpec {
  /** The executable's file name (on PATH and in the nix output's bin/). */
  name: string;
  /** Environment variable that overrides it with a path. */
  env: string;
  /** Its nixpkgs attribute (in nix/bins.json when pinned). */
  nix: string;
  candidates?: string[];
  /** False when the copy on PATH is not the one to run (NixOS's sway is wrapped in dbus-run-session). Default true. */
  path?: boolean;
  /** The directory of the nix output it is in, when not bin/ (portals live in libexec/). */
  sub?: string;
  /** From the pinned nixpkgs, prepared ahead of time (above); never built by the process that runs it. */
  pinned?: boolean;
}

/** Where the prepared packages are: a directory of links named by attribute (nix/overlay.nix's dither-bins). */
export const BINS_ENV = 'DITHER_BINS';

/** A pinned program that is not prepared: says how to prepare it. */
export class BinNotPrepared extends Error {}

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

/** The prepared package's program: DITHER_BINS/<attr> (a link to the package's store path), then its bin/ or sub. */
export function preparedBin(spec: BinSpec, dir = process.env[BINS_ENV]): string | null {
  if (!dir) return null;
  try {
    const pkg = realpathSync(join(dir, spec.nix));
    const bin = join(pkg, spec.sub ?? 'bin', spec.name);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** A binary's real path, or throws saying how to provide it. */
export function resolveBin(spec: BinSpec, log: Log): string {
  const key = `${spec.name}\0${spec.nix}`;
  const hit = cache.get(key);
  if (hit && existsSync(hit)) return hit;
  const found = (() => {
    const fromEnv = process.env[spec.env];
    if (fromEnv && existsSync(fromEnv)) return real(fromEnv);
    if (spec.pinned) {
      const prepared = preparedBin(spec);
      if (prepared) return prepared;
    }
    const onPath = spec.path === false ? null : Bun.which(spec.name);
    if (onPath) return real(onPath);
    for (const c of spec.candidates ?? []) if (existsSync(c)) return real(c);
    if (spec.pinned) {
      const dir = process.env[BINS_ENV];
      throw new BinNotPrepared(
        `${spec.name} is not prepared: ${dir ? `${dir} has no ${spec.nix} with ${spec.sub ?? 'bin'}/${spec.name}` : `${BINS_ENV} is not set`}. ` +
          `The manager prepares the sandboxes' programs at its start (docs/browser.md "Programs"); by hand: bun scripts/prepare-bins.ts --out <dir>, then ${BINS_ENV}=<dir>, or set ${spec.env}`,
      );
    }
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

/** The display backends' programs (screen.ts), pinned. */
export const DISPLAY_BINS = {
  xvfb: { name: 'Xvfb', env: 'XVFB_BIN', nix: 'xvfb', pinned: true },
  x11vnc: { name: 'x11vnc', env: 'X11VNC_BIN', nix: 'x11vnc', pinned: true },
  xdotool: { name: 'xdotool', env: 'XDOTOOL_BIN', nix: 'xdotool', pinned: true },
  import: { name: 'import', env: 'IMPORT_BIN', nix: 'imagemagick', pinned: true },
  // sway-unwrapped: NixOS's `sway` runs it under dbus-run-session, a session bus of its own we neither want nor stop.
  sway: { name: 'sway', env: 'SWAY_BIN', nix: 'sway-unwrapped', path: false, pinned: true },
  wayvnc: { name: 'wayvnc', env: 'WAYVNC_BIN', nix: 'wayvnc', pinned: true },
  grim: { name: 'grim', env: 'GRIM_BIN', nix: 'grim', pinned: true },
  // Puts characters a US keyboard lacks on keys of their own for typing on X (screen.ts, XScreen.type).
  xmodmap: { name: 'xmodmap', env: 'XMODMAP_BIN', nix: 'xmodmap', pinned: true },
  // TigerVNC's Xvnc (the tigervnc backend), from nixpkgs as it ships it. Not from PATH: other Xvnc builds share the name.
  tigervnc: { name: 'Xvnc', env: 'TIGERVNC_XVNC_BIN', nix: 'tigervnc', path: false, pinned: true },
  // KasmVNC's Xvnc (the kasmvnc backend), built from the owner's fork (nix/kasmvnc.nix).
  kasmvnc: { name: 'Xkasmvnc', env: 'KASMVNC_BIN', nix: 'kasmvnc', path: false, pinned: true },
  // TigerVNC's Wayland server (the wayland-tigervnc backend), built from the owner's fork (nix/w0vncserver.nix):
  // nixpkgs' own exits without a desktop portal and crashes on a seat with no keyboard.
  w0vncserver: { name: 'w0vncserver', env: 'W0VNCSERVER_BIN', nix: 'w0vncserver', path: false, pinned: true },
} satisfies Record<string, BinSpec>;

/** The programs each backend's screen starts (input and pictures aside): without them it cannot start. */
export const BACKEND_BINS: Record<DisplayBackend, BinSpec[]> = {
  x11: [DISPLAY_BINS.xvfb, DISPLAY_BINS.x11vnc],
  tigervnc: [DISPLAY_BINS.tigervnc],
  kasmvnc: [DISPLAY_BINS.kasmvnc],
  wayland: [DISPLAY_BINS.sway, DISPLAY_BINS.wayvnc, DISPLAY_BINS.grim],
  'wayland-tigervnc': [DISPLAY_BINS.sway, DISPLAY_BINS.w0vncserver, DISPLAY_BINS.grim],
};

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
