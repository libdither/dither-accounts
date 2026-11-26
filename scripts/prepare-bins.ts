/**
 * Build the sandboxes' programs from the repo's pinned nixpkgs (nix/README.md) into a directory of links, as the
 * manager does at its start (packages/manager prepare.ts), and print the line to point the sandboxes at it:
 *
 *   bun scripts/prepare-bins.ts --out <dir> [--tests]
 *
 * --tests adds what only the tests run (nix/bins.json "test": Electron, xev, wev). CI's `nix` job runs it before the
 * tests that need Nix; run it before them yourself, then export DITHER_BINS=<dir>.
 */
import { resolve } from 'node:path';
import { prepareBins } from '../packages/manager/src/prepare.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : undefined;
if (!out) {
  console.error('usage: bun scripts/prepare-bins.ts --out <dir> [--tests]');
  process.exit(2);
}
const r = await prepareBins({ repoRoot: resolve(import.meta.dir, '..'), out: resolve(out), attr: args.includes('--tests') ? 'dither-test-bins' : 'dither-bins', log: (l, m) => console.error(`${l}: ${m}`) });
if (r.why) {
  console.error(r.why);
  process.exit(1);
}
console.log(`DITHER_BINS=${r.dir}`);
