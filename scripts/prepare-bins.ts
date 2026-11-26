/**
 * Build the sandboxes' programs from the repo's pinned nixpkgs (nix/README.md) into a directory of links, as the
 * manager does at its start (packages/manager prepare.ts), then the servers built from forks this project keeps into a
 * second one beside it (`<dir>-forks`, as the manager's bins-forks), and print the line to point the sandboxes at both:
 *
 *   bun scripts/prepare-bins.ts --out <dir> [--tests] [--no-forks]
 *
 * --tests adds what only the tests run (nix/bins.json "test": Electron, xev, wev). --no-forks leaves the forks' servers
 * out (the kasmvnc and wayland-tigervnc backends then cannot start). CI's `nix` job runs it before the tests that need
 * Nix; run it before them yourself, then export the DITHER_BINS it prints.
 */
import { resolve } from 'node:path';
import { type BinsAttr, prepareBins } from '../packages/manager/src/prepare.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : undefined;
if (!out) {
  console.error('usage: bun scripts/prepare-bins.ts --out <dir> [--tests] [--no-forks]');
  process.exit(2);
}
const repoRoot = resolve(import.meta.dir, '..');
const log = (l: string, m: string) => console.error(`${l}: ${m}`);
const dirs: string[] = [];
const builds: [BinsAttr, string][] = [[args.includes('--tests') ? 'dither-test-bins' : 'dither-bins', resolve(out)]];
if (!args.includes('--no-forks')) builds.push(['dither-bins-forks', `${resolve(out)}-forks`]);
for (const [attr, dir] of builds) {
  const r = await prepareBins({ repoRoot, out: dir, attr, log });
  if (r.why) {
    console.error(r.why);
    process.exit(1);
  }
  dirs.push(r.dir!);
}
console.log(`DITHER_BINS=${dirs.join(':')}`);
