/**
 * What some tests need from the machine beyond bun, so they skip where it is missing (as on GitHub's runners) instead
 * of failing: Nix (Radicale and Dovecot come from nixpkgs, unless RADICALE_BIN or DOVECOT_BIN name them), the
 * native-app sandbox (bubblewrap, Xvfb, x11vnc and dbus from /nix/store: packages/sandbox), and the wayland display
 * backend (sway, wayvnc and grim: packages/browser/src/wayland.ts). The sandboxes' programs come prepared from the
 * pinned nixpkgs (`bun scripts/prepare-bins.ts --out <dir> --tests`, then DITHER_BINS=<dir>: nix/README.md); without
 * that, from PATH, where most are missing.
 *
 * Bun runs a file's beforeAll and afterAll even when its tests are skipped, so a file that skips whole returns from
 * its hooks early too.
 */
import { type BinSpec, DISPLAY_BINS, resolveBin } from '../packages/browser/src/bins.ts';
import { type Bins, resolveBins } from '../packages/browser/src/sandbox.ts';
import { BINS, sandboxBins } from '../packages/sandbox/src/bins.ts';

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

/** What only the tests run, from the pinned nixpkgs too (nix/bins.json "test"). */
export const TEST_BINS = {
  electron: { name: 'electron', env: 'ELECTRON_BIN', nix: 'electron', pinned: true },
  xev: { name: 'xev', env: 'XEV_BIN', nix: 'xorg.xev', pinned: true },
  wev: { name: 'wev', env: 'WEV_BIN', nix: 'wev', pinned: true },
} satisfies Record<string, BinSpec>;

/** A Wayland client with a window that prints what it gets (wev), for the backend's own window and input tests. */
export const wev = (() => {
  try {
    resolveBin(TEST_BINS.wev, () => {});
    return true;
  } catch {
    return false;
  }
})();

/** X apps on the wayland backend: xwayland-satellite (with its Xwayland) and xev, the X client the tests drive. */
export const satellite = (() => {
  try {
    resolveBin(BINS.satellite, () => {});
    resolveBin(TEST_BINS.xev, () => {});
    return true;
  } catch {
    return false;
  }
})();

/**
 * Says why a test skips. Where the machine must have everything (CI's `nix` job sets DITHER_TESTS_NEED_ALL=1), a
 * missing program fails the file instead, so that job cannot pass by skipping.
 */
export function why(what: string, ok: boolean) {
  if (!ok && process.env.DITHER_TESTS_NEED_ALL === '1') throw new Error(`${what} is not available here, and DITHER_TESTS_NEED_ALL=1`);
  if (!ok) console.warn(`skipped: ${what} is not available here`);
  return ok;
}

/**
 * Xvfb, x11vnc and Chromium, for a test that runs a real browser on X (`name` says which), or null: it then skips,
 * saying why and how to run it. They come prepared from the pinned nixpkgs (DITHER_BINS: nix/README.md), as everything
 * the sandboxes run does. Where the machine must have everything (DITHER_TESTS_NEED_ALL=1) a missing one fails instead.
 */
export function browserBins(name: string): Bins | null {
  try {
    return resolveBins(() => {});
  } catch (e) {
    const msg = `${name} needs Xvfb, x11vnc and Chromium from the pinned nixpkgs (${(e as Error).message.split(/\. /)[0]}): bun scripts/prepare-bins.ts --out <dir> --tests, then DITHER_BINS=<dir> (nix/README.md)`;
    if (process.env.DITHER_TESTS_NEED_ALL === '1') throw new Error(`${msg}, and DITHER_TESTS_NEED_ALL=1`);
    console.warn(`skipped: ${msg}`);
    return null;
  }
}
