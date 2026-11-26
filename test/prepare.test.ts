/**
 * The sandboxes' programs, prepared at the manager's start (packages/manager/src/prepare.ts) with a stand-in
 * nix-build: an extractor of a kind with a screen starts only once they are ready and is given their directory
 * (DITHER_BINS) and its display backend; one of a kind with no screen starts at once, with neither. A failed build keeps
 * the last good out-link.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { newToken } from '../packages/manager/src/db.ts';
import { prepareBins } from '../packages/manager/src/prepare.ts';
import fakeManifest from '../extractors/fake/manifest.ts';

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, '..');
const RUN = process.pid.toString(36);
const dirs: string[] = [];
const managers: Manager[] = [];
afterAll(async () => {
  for (const m of managers) await m.stop().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-prepare-${p}-`));
  dirs.push(d);
  return d;
};

/**
 * A nix-build that waits for `<dir>/go`, then makes `-o`'s link to `<dir>/store` (or, with `<dir>/fail`, fails), and
 * writes the arguments it was given to `<dir>/args`.
 */
function fakeNixBuild(dir: string): string {
  mkdirSync(join(dir, 'store'), { recursive: true });
  const script = join(dir, 'nix-build');
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args'
while [ ! -e '${dir}/go' ]; do sleep 0.02; done
if [ -e '${dir}/fail' ]; then echo "error: the build failed" >&2; exit 1; fi
out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
ln -sfn '${dir}/store' "$out"
echo '${dir}/store'
`,
    { mode: 0o755 },
  );
  return script;
}

function addAccount(m: Manager, dir: string, id: string, kind: string) {
  const accDir = join(dir, 'accounts', id);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  m.store.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', id, kind, 'Fake', '{}', newToken(), accDir, now, now);
}

const until = async (what: string, f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const envOf = (pid: number) => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('a kind with a screen starts once the programs are prepared, with their directory; one without starts at once, with neither', async () => {
  const dir = tmp('manager');
  const nix = tmp('nix');
  const fake = kindOf(fakeManifest, join(ROOT, 'extractors/fake'));
  const plain = kindOf({ ...fakeManifest, kind: 'plain', screen: undefined }, join(ROOT, 'extractors/fake'));
  const m = await createManager({ dataDir: dir, port: 0, kinds: new Map([['fake', fake], ['plain', plain]]), launch: 'child', displayBackend: 'wayland', prepareBins: { nixBuild: fakeNixBuild(nix) } });
  managers.push(m);
  const screenId = `acc-prep-screen-${RUN}`;
  const plainId = `acc-prep-plain-${RUN}`;
  addAccount(m, dir, screenId, 'fake');
  addAccount(m, dir, plainId, 'plain');
  m.sup.start(screenId);
  m.sup.start(plainId);
  await until('the kind without a screen running', () => !!m.sup.details(plainId).pid);
  // The other waits for the build, which waits for `go`.
  await until('the build started', () => existsSync(join(nix, 'args')));
  expect(m.sup.details(screenId).pid).toBeFalsy();
  expect(readFileSync(join(nix, 'args'), 'utf8').trim().split('\n')).toEqual([join(ROOT, 'nix'), '-A', 'dither-bins', '-o', join(dir, 'bins')]);
  const plainEnv = envOf(m.sup.details(plainId).pid!);
  expect(plainEnv.DITHER_BINS).toBeUndefined();
  expect(plainEnv.DITHER_DISPLAY_BACKEND).toBeUndefined();
  expect(m.sup.details(plainId).displayBackend).toBeNull();

  writeFileSync(join(nix, 'go'), '');
  expect((await m.bins)!).toMatchObject({ dir: join(dir, 'bins') });
  expect(readlinkSync(join(dir, 'bins'))).toBe(join(nix, 'store'));
  await until('the kind with a screen running', () => !!m.sup.details(screenId).pid);
  const env = envOf(m.sup.details(screenId).pid!);
  expect(env.DITHER_BINS).toBe(join(dir, 'bins'));
  expect(env.DITHER_DISPLAY_BACKEND).toBe('wayland');
  expect(m.sup.details(screenId).displayBackend).toBe('wayland');
});

test('a failed build keeps the last good programs; no nix-build at all leaves them to PATH', async () => {
  const dir = tmp('fails');
  const nix = tmp('nix-fails');
  const script = fakeNixBuild(nix);
  writeFileSync(join(nix, 'go'), '');
  expect(await prepareBins({ repoRoot: ROOT, dataDir: dir, nixBuild: script })).toMatchObject({ dir: join(dir, 'bins') });
  writeFileSync(join(nix, 'fail'), '');
  const logs: string[] = [];
  const r = await prepareBins({ repoRoot: ROOT, dataDir: dir, nixBuild: script, log: (l, msg) => logs.push(`${l} ${msg}`) });
  expect(r.dir).toBe(join(dir, 'bins'));
  expect(r.why).toMatch(/nix-build exited 1: error: the build failed/);
  expect(logs.some((l) => l.startsWith('warn') && l.includes('the last ones stay'))).toBe(true);
  expect(readlinkSync(join(dir, 'bins'))).toBe(join(nix, 'store'));
  const none = tmp('none');
  const was = process.env.PATH;
  try {
    process.env.PATH = none;
    expect(await prepareBins({ repoRoot: ROOT, dataDir: none })).toMatchObject({ dir: null, why: 'no nix-build' });
  } finally {
    process.env.PATH = was;
  }
});
