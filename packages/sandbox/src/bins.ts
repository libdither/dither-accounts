/**
 * Programs the native-app sandbox runs, found by packages/browser's resolveBin (bins.ts there): an environment
 * override, then PATH, then known places, then `nix build nixpkgs#<attr>`, resolved to their real /nix/store path.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type BinSpec, DISPLAY_BINS, type Log, resolveBin, tryBin } from '@dither-accounts/browser/bins';

export { type BinSpec, type Log, resolveBin, tryBin };

export const BINS = {
  xvfb: DISPLAY_BINS.xvfb,
  x11vnc: DISPLAY_BINS.x11vnc,
  bwrap: { name: 'bwrap', env: 'BWRAP_BIN', nix: 'bubblewrap' },
  pasta: { name: 'pasta', env: 'PASTA_BIN', nix: 'passt' },
  dbusDaemon: { name: 'dbus-daemon', env: 'DBUS_DAEMON_BIN', nix: 'dbus', candidates: ['/run/current-system/sw/bin/dbus-daemon'] },
  xdotool: DISPLAY_BINS.xdotool,
  pulseaudio: { name: 'pulseaudio', env: 'PULSEAUDIO_BIN', nix: 'pulseaudio' },
  sh: { name: 'sh', env: 'SANDBOX_SH_BIN', nix: 'bash', candidates: ['/bin/sh'] },
  env: { name: 'env', env: 'SANDBOX_COREUTILS_ENV', nix: 'coreutils', candidates: ['/usr/bin/env'] },
  /** X apps on the wayland backend: an Xwayland of the app's own, inside its sandbox (AppSandboxOptions.x11App). */
  satellite: { name: 'xwayland-satellite', env: 'XWAYLAND_SATELLITE_BIN', nix: 'xwayland-satellite' },
} satisfies Record<string, BinSpec>;

export interface SandboxBins {
  bwrap: string;
  dbusDaemon: string;
  /** dbus-send from the same package as dbus-daemon: what the shims call. */
  dbusSend: string;
  sh: string;
  /** coreutils' bin directory: the sandbox's PATH after the shims. */
  coreutils: string;
  pasta: string | null;
  /** Only when the sandbox has audio devices (AppSandboxOptions.audio). */
  pulseaudio: string | null;
}

/** What every native-app sandbox runs besides its screen (screen.ts resolves the display backend's own programs). */
export function sandboxBins(log: Log, want: { pasta: boolean; pulseaudio?: boolean }): SandboxBins {
  const dbusDaemon = resolveBin(BINS.dbusDaemon, log);
  const dbusSend = join(dirname(dbusDaemon), 'dbus-send');
  if (!existsSync(dbusSend)) throw new Error(`${dirname(dbusDaemon)} has dbus-daemon but no dbus-send`);
  const sh = resolveBin(BINS.sh, log);
  const env = resolveBin(BINS.env, log);
  for (const [name, p] of Object.entries({ 'dbus-daemon': dbusDaemon, sh, env })) {
    if (!p.startsWith('/nix/store/')) throw new Error(`${name} is ${p}, outside /nix/store, so the sandbox cannot run it`);
  }
  return {
    bwrap: resolveBin(BINS.bwrap, log),
    dbusDaemon,
    dbusSend,
    sh,
    coreutils: dirname(env),
    pasta: want.pasta ? tryBin(BINS.pasta, log) : null,
    pulseaudio: want.pulseaudio ? resolveBin(BINS.pulseaudio, log) : null,
  };
}
