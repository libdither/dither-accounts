/**
 * What some tests need from the machine beyond bun, so they skip where it is missing (as on GitHub's runners) instead
 * of failing: Nix (Radicale and Dovecot come from nixpkgs, unless RADICALE_BIN or DOVECOT_BIN name them), the
 * native-app sandbox (bubblewrap, Xvfb, x11vnc and dbus from /nix/store: packages/sandbox), and the wayland display
 * backend (sway, wayvnc and grim: packages/browser/src/wayland.ts). A machine with Nix has them all.
 *
 * Bun runs a file's beforeAll and afterAll even when its tests are skipped, so a file that skips whole returns from
 * its hooks early too.
 */
import { DISPLAY_BINS, resolveBin } from '../packages/browser/src/bins.ts';
import { sandboxBins } from '../packages/sandbox/src/bins.ts';

export const nix = !!Bun.which('nix');

export const radicale = nix || !!process.env.RADICALE_BIN;
export const dovecot = nix || !!process.env.DOVECOT_BIN;

export const sandbox = (() => {
  try {
    sandboxBins(() => {}, { pasta: false });
    resolveBin(DISPLAY_BINS.xvfb, () => {});
    resolveBin(DISPLAY_BINS.x11vnc, () => {});
    return true;
  } catch {
    return false;
  }
})();

export const wayland = (() => {
  try {
    for (const b of [DISPLAY_BINS.sway, DISPLAY_BINS.wayvnc, DISPLAY_BINS.grim]) resolveBin(b, () => {});
    return true;
  } catch {
    return false;
  }
})();

/** X apps on the wayland backend: xwayland-satellite (with its Xwayland) and xev, the X client the tests drive. */
export const satellite = (() => {
  try {
    resolveBin({ name: 'xwayland-satellite', env: 'XWAYLAND_SATELLITE_BIN', nix: 'xwayland-satellite' }, () => {});
    resolveBin({ name: 'xev', env: 'XEV_BIN', nix: 'xorg.xev' }, () => {});
    return true;
  } catch {
    return false;
  }
})();

export function why(what: string, ok: boolean) {
  if (!ok) console.warn(`skipped: ${what} is not available here`);
  return ok;
}
