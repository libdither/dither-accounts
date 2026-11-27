/**
 * Run the test files a branch adds or changes several times over, so a flaky test fails the pull request that brings
 * it in rather than a later one. CI runs it on each pull request; run it yourself before pushing:
 *
 *   bun scripts/flake-check.ts [base] [path...]
 *
 * base is the branch to compare with (origin/master by default); paths, when given, keep only the changed test files
 * under them (CI's `nix` job runs it for the sandbox tests, which skip in `unit`). FLAKE_RUNS sets how many times each
 * file runs (5).
 */
import { $ } from 'bun';

const base = process.argv[2] ?? 'origin/master';
const under = process.argv.slice(3).map((p) => p.replace(/^\.\//, '').replace(/\/?$/, ''));
const runs = Number(process.env.FLAKE_RUNS ?? 5);

const changed = (await $`git diff --name-only --diff-filter=AMR ${base}...HEAD`.text())
  .split('\n')
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => under.length === 0 || under.some((p) => f === p || f.startsWith(`${p}/`)));

if (changed.length === 0) {
  console.log(`No test files added or changed since ${base}${under.length ? ` under ${under.join(', ')}` : ''}.`);
  process.exit(0);
}
console.log(`Running ${changed.length} changed test file(s) ${runs} times each:\n  ${changed.join('\n  ')}`);
// A "./" prefix makes bun take each as a path, not a name filter.
const proc = Bun.spawn(['bun', 'test', '--rerun-each', String(runs), ...changed.map((f) => `./${f}`)], { stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(await proc.exited);
