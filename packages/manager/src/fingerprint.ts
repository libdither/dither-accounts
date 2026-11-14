/**
 * A fingerprint of the code an extractor runs, so a manager that adopts one started by an earlier release can tell
 * whether its code changed since (supervisor.ts: only changed extractors restart after a deploy).
 *
 * What it covers:
 * - Every file of this repo the entry reaches through its imports (Bun's own scan, so type-only imports, which run
 *   nothing, are left out): a change to a part of packages/chat-protocol that Discord never imports does not restart it.
 * - In each package those files belong to, every file that is not TypeScript (a browser extension's scripts, a hook's
 *   page script, a proto, a manifest.json): extractors read those as files, not as imports. TypeScript is only ever run
 *   through an import, so the TypeScript that is not reached does not count.
 * - The name and installed version of each npm package imported directly, the repo's bun.lock, package.json and
 *   tsconfig.json, and Bun's version.
 * - The environment the manager gives it that is not per account (its kind's `env`, PATH, DITHER_* settings such as
 *   DITHER_TELEGRAM_DESKTOP), as a hash only.
 * Not seen: a file read at run time from outside the packages it imports.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Never part of what runs. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '.git', 'dist', '.cache']);
const SCAN = /\.(ts|tsx|js|mjs|cjs|jsx)$/;
const TYPESCRIPT = /\.(ts|tsx|mts|cts)$/;
/** The repo's files that change what every extractor runs. */
const ROOT_FILES = ['bun.lock', 'package.json', 'tsconfig.json'];
/** Set by the supervisor per account or per start: not part of the code. */
const PER_START = /^DITHER_(ACCOUNT_|HUB_URL$|ACCOUNTS_URL$|ADAPTER_TOKEN$|MARKER_KEY$|MANAGER_|EXTRACTOR_)/;

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

/** A package's files that are not TypeScript (its assets), by path, without node_modules and tests. */
function assetsOf(dir: string): string[] {
  const out: string[] = [];
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
      if (st.isDirectory()) {
        // A package inside this one is its own (reached or not).
        if (!existsSync(join(p, 'package.json'))) walk(p);
      } else if (st.isFile() && !TYPESCRIPT.test(n)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export interface Fingerprint {
  hash: string;
  /** The repo's package directories it covers, relative to the root. */
  packages: string[];
  /** The repo's files it covers, relative to the root. */
  files: string[];
  /** npm packages imported directly, with their versions. */
  external: string[];
}

/** The part of an environment that counts: not per account, not the manager's own settings. */
export function codeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === 'PATH' || (k.startsWith('DITHER_') && !k.startsWith('DITHER_ACCOUNTS_') && !PER_START.test(k))) out[k] = v;
  }
  return out;
}

/**
 * The fingerprint of an extractor whose entry is `entry` (absolute), in the repo at `root`, started with `env` (its
 * kind's env and the manager's, codeEnv picks what counts).
 */
export function fingerprintEntry(root: string, entry: string, env: Record<string, string | undefined> = {}): Fingerprint {
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
      imports = transpilers[file.endsWith('.ts') ? 'ts' : 'tsx'].scanImports(readFileSync(file, 'utf8'));
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
  // The files reached, and the packages' assets; the repo root as a package would be everything, so only its own files.
  const files = new Set([...seen].filter((f) => inside(f, root)));
  for (const d of packages) if (d !== root) for (const a of assetsOf(d)) files.add(a);
  for (const f of ROOT_FILES) if (existsSync(join(root, f))) files.add(join(root, f));
  const rel = [...files].map((f) => relative(root, f)).sort();
  const h = createHash('sha256');
  h.update('dither-accounts extractor fingerprint 2\n');
  h.update(`bun ${Bun.version}\n`);
  for (const f of rel) {
    let data: Buffer;
    try {
      data = readFileSync(join(root, f));
    } catch {
      continue;
    }
    h.update(`f ${f} ${data.length}\n`);
    h.update(data);
  }
  const ext = [...external].map(([n, v]) => `${n}@${v}`).sort();
  for (const e of ext) h.update(`x ${e}\n`);
  const ce = codeEnv(env);
  for (const k of Object.keys(ce).sort()) h.update(`e ${k}=${ce[k]}\n`);
  return { hash: h.digest('hex').slice(0, 32), packages: [...packages].map((d) => relative(root, d) || '.').sort(), files: rel, external: ext };
}

/** Whether two fingerprints say the same code: an unknown one (it could not be made) is never the same. */
export function sameCode(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && !a.startsWith('unknown') && !b.startsWith('unknown') && a === b;
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
