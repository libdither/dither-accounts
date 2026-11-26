/**
 * A kind whose extractor runs a sandbox with a screen says so in its manifest (`screen`), or it gets no display backend
 * and no prepared programs (supervisor.ts) and its sandbox fails to start. And a kind that says so has a screen to run.
 *
 * "Runs a sandbox" is read from the code, not from package.json: the files its entry reaches through its imports
 * (relative ones and workspace packages, followed however deep, through statements-common or Meta's shared code too)
 * include one that builds a sandbox or a screen. A dependency alone does not count: monero and simplefin depend on
 * statements-common and never reach its tabs.
 */
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = realpathSync(resolve(import.meta.dir, '..'));
const EXTRACTORS = join(ROOT, 'extractors');
/** What starts a screen: the browser sandbox, the native-app sandbox, or a screen of its own. */
const BUILDS_SCREEN = /\bnew (?:Sandbox|AppSandbox)\(|\bmakeScreen\(/;
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** The repo's files `entry` reaches through its imports, and those of them that build a screen. */
function reached(entry: string): { files: Set<string>; building: string[] } {
  const files = new Set<string>();
  const building: string[] = [];
  const todo = [realpathSync(entry)];
  while (todo.length) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const code = readFileSync(f, 'utf8');
    if (BUILDS_SCREEN.test(code)) building.push(f.slice(ROOT.length + 1));
    // Type-only imports are left out by the transpiler: they run nothing.
    for (const i of transpiler.scanImports(code)) {
      let to: string;
      try {
        to = realpathSync(Bun.resolveSync(i.path, dirname(f)));
      } catch {
        continue; // a builtin (node:fs, bun:ffi)
      }
      if (to.startsWith(`${ROOT}/`) && !to.includes('/node_modules/') && /\.tsx?$/.test(to)) todo.push(to);
    }
  }
  return { files, building };
}

test('the import walk finds what builds a screen however deep it is, and nothing for a kind that only depends on it', () => {
  // Through statements-common's tabs: amazon builds none itself.
  expect(reached(join(EXTRACTORS, 'amazon', 'src', 'main.ts')).building).toContain('extractors/statements-common/src/tabs.ts');
  // monero depends on statements-common, and reaches nothing that builds one.
  expect(reached(join(EXTRACTORS, 'monero', 'src', 'main.ts')).building).toEqual([]);
});

test('every kind that runs a sandbox has `screen` in its manifest, and only those', () => {
  const missing: Record<string, string[]> = {};
  const extra: string[] = [];
  for (const kind of readdirSync(EXTRACTORS)) {
    const manifest = join(EXTRACTORS, kind, 'manifest.ts');
    if (!existsSync(manifest)) continue;
    const src = readFileSync(manifest, 'utf8');
    const entry = join(EXTRACTORS, kind, src.match(/\bentry:\s*'([^']+)'/)?.[1] ?? 'src/main.ts');
    const { building } = reached(entry);
    const says = /^\s*screen:/m.test(src);
    if (building.length && !says) missing[kind] = building;
    // The fake takes a backend without drawing, so the supervisor's tests can move it.
    if (says && !building.length && kind !== 'fake') extra.push(kind);
  }
  expect({ missing, extra }).toEqual({ missing: {}, extra: [] });
});
