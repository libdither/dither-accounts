/**
 * What some tests need from the machine beyond bun, so they skip where it is missing (as on GitHub's runners) instead
 * of failing: Nix (Radicale and Dovecot come from nixpkgs, unless RADICALE_BIN or DOVECOT_BIN name them), and the
 * native-app sandbox (bubblewrap, Xvfb, x11vnc and dbus from /nix/store: packages/sandbox). A machine with Nix has them all.
 *
 * Bun runs a file's beforeAll and afterAll even when its tests are skipped, so a file that skips whole returns from
 * its hooks early too.
 */
import { sandboxBins } from '../packages/sandbox/src/bins.ts';

export const nix = !!Bun.which('nix');

export const radicale = nix || !!process.env.RADICALE_BIN;
export const dovecot = nix || !!process.env.DOVECOT_BIN;

export const sandbox = (() => {
  try {
    sandboxBins(() => {}, { pasta: false, xdotool: false });
    return true;
  } catch {
    return false;
  }
})();

export function why(what: string, ok: boolean) {
  if (!ok) console.warn(`skipped: ${what} is not available here`);
  return ok;
}
