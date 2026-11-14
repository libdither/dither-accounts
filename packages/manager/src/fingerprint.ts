/**
 * A fingerprint of the code an extractor runs, so a manager that adopts one started by an earlier release can tell
 * whether its code changed since (supervisor.ts: only changed extractors restart after a deploy).
 *
 * It follows the entry's imports (Bun's own scan, so type-only imports, which run nothing, are left out) to find the
 * packages of this repo the extractor loads: its kind's directory and, say, packages/browser and packages/link, not
 * packages/manager for a manifest's type. Each such package is hashed whole (its files' paths and contents, without
 * node_modules and tests), since extractors also read files that are no import (a browser extension, a hook's page
 * script, a proto). A dependency from npm counts by its name and installed version. A version that changes only deep
 * inside npm's tree (bun.lock moves a dependency of a dependency) is not seen.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Never part of what runs. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '.git', 'dist', '.cache']);
const SCAN = /\.(ts|tsx|js|mjs|cjs|jsx)$/;

/** The package directory a file belongs to: the nearest one with a package.json, not past `root`. */
function packageDirOf(file: string, root: string): string | null {
  let d = dirname(file);
  while (d.startsWith(root)) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function inside(file: string, dir: string) {
  return file === dir || file.startsWith(dir + sep);
}

/** Hash of a directory's files, by path relative to `root`, in a fixed order. */
function hashDir(h: ReturnType<typeof createHash>, dir: string, root: string) {
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        h.update(`f ${relative(root, p)} ${st.size}\n`);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
}

export interface Fingerprint {
  hash: string;
  /** The repo's package directories it covers, relative to the root. */
  packages: string[];
  /** npm packages imported directly, with their versions. */
  external: string[];
}

/** The fingerprint of an extractor whose entry is `entry` (absolute), in the repo at `root`. */
export function fingerprintEntry(root: string, entry: string): Fingerprint {
  root = realpathSync(root);
  entry = realpathSync(entry);
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };
  const seen = new Set<string>();
  const packages = new Set<string>();
  const external = new Map<string, string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const pkg = packageDirOf(file, root);
    if (pkg) packages.add(pkg);
    if (!SCAN.test(file)) continue;
    let imports: { path: string }[] = [];
    try {
      const src = readFileSync(file, 'utf8');
      imports = transpilers[file.endsWith('.ts') ? 'ts' : 'tsx'].scanImports(src);
    } catch {
      continue;
    }
    for (const { path } of imports) {
      if (path.startsWith('node:') || path.startsWith('bun:') || path === 'bun') continue;
      let to: string;
      try {
        to = Bun.resolveSync(path, dirname(file));
      } catch {
        continue;
      }
      if (!to.startsWith('/')) continue; // a builtin
      try {
        to = realpathSync(to);
      } catch {
        continue;
      }
      if (!inside(to, root) || to.split(sep).includes('node_modules')) {
        const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]!;
        if (!external.has(name)) external.set(name, versionOf(to, name));
        continue;
      }
      todo.push(to);
    }
  }
  const dirs = [...packages].map((d) => relative(root, d) || '.').sort();
  const h = createHash('sha256');
  h.update('dither-accounts extractor fingerprint 1\n');
  for (const d of dirs) {
    h.update(`p ${d}\n`);
    // The repo root as a package would be everything: only its own files, not its subdirectories' packages.
    if (d === '.') continue;
    hashDir(h, join(root, d), root);
  }
  const ext = [...external].map(([n, v]) => `${n}@${v}`).sort();
  for (const e of ext) h.update(`x ${e}\n`);
  return { hash: h.digest('hex').slice(0, 32), packages: dirs, external: ext };
}

/** The version in the package.json of the npm package `name` that `file` belongs to. */
function versionOf(file: string, name: string): string {
  let d = dirname(file);
  for (let i = 0; i < 12; i++) {
    const pj = join(d, 'package.json');
    if (existsSync(pj)) {
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string };
        if (j.name === name) return j.version ?? '?';
      } catch {}
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return '?';
}
