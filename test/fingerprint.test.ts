/**
 * The fingerprint of an extractor's code (packages/manager/src/fingerprint.ts): what changes it and what does not, on
 * a small workspace made here. And the pid guard the supervisor signals through (procs.ts).
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codeEnv, fingerprintEntry, lockEntries, sameCode } from '../packages/manager/src/fingerprint.ts';
import { procAlive, procStat } from '../packages/manager/src/procs.ts';

const root = mkdtempSync(join(tmpdir(), 'dacc-fp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (p: string, text: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), text);
};

put('package.json', JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*', 'extractors/*'] }));
put('packages/shared/package.json', JSON.stringify({ name: '@t/shared', exports: { '.': './src/index.ts' } }));
put('packages/shared/src/index.ts', 'export const shared = 1;\n');
put('packages/other/package.json', JSON.stringify({ name: '@t/other', exports: { '.': './src/index.ts' } }));
put('packages/other/src/index.ts', 'export type Manifest = { kind: string };\nexport const other = 1;\n');
put('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js' }));
put('node_modules/left-pad/index.js', 'module.exports = (s) => s;\n');
mkdirSync(join(root, 'node_modules/@t'), { recursive: true });
symlinkSync(join(root, 'packages/shared'), join(root, 'node_modules/@t/shared'));
symlinkSync(join(root, 'packages/other'), join(root, 'node_modules/@t/other'));
put('extractors/x/package.json', JSON.stringify({ name: '@t/x', dependencies: { '@t/shared': 'workspace:*', '@t/other': 'workspace:*' } }));
put('extractors/x/manifest.ts', "import type { Manifest } from '@t/other';\nexport default { kind: 'x' } satisfies Manifest;\n");
put('extractors/x/src/main.ts', "import { shared } from '@t/shared';\nimport type { Manifest } from '@t/other';\nimport pad from 'left-pad';\nimport { util } from './util.ts';\nconsole.log(shared, util, pad);\n");
put('extractors/x/src/util.ts', 'export const util = 1;\n');
put('extractors/x/src/extension/hook.js', '// read as a file by the extractor, never imported\n');
put('extractors/x/test/x.test.ts', 'test\n');
put('extractors/y/package.json', JSON.stringify({ name: '@t/y' }));
put('extractors/y/src/main.ts', 'console.log(1);\n');

const fp = () => fingerprintEntry(root, join(root, 'extractors/x/src/main.ts'));

test('it covers the packages an extractor imports at run time, and the npm packages by version', () => {
  const f = fp();
  // Not packages/other: only its type is imported, which runs nothing.
  expect(f.packages).toEqual(['extractors/x', 'packages/shared']);
  expect(f.external).toEqual(['left-pad@1.3.0']);
  expect(fp().hash).toBe(f.hash);
});

test('a change elsewhere, or in its tests, leaves it; a change in what it runs, a file it reads or a version changes it', () => {
  const before = fp().hash;
  put('packages/other/src/index.ts', 'export type Manifest = { kind: string };\nexport const other = 2;\n');
  put('extractors/y/src/main.ts', 'console.log(2);\n');
  put('extractors/x/test/x.test.ts', 'test changed\n');
  put('node_modules/unrelated/package.json', '{}');
  expect(fp().hash).toBe(before);

  put('packages/shared/src/index.ts', 'export const shared = 2;\n');
  const shared = fp().hash;
  expect(shared).not.toBe(before);

  put('extractors/x/src/extension/hook.js', '// changed\n');
  const asset = fp().hash;
  expect(asset).not.toBe(shared);

  put('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.3.1', main: 'index.js' }));
  expect(fp().hash).not.toBe(asset);
});

test("a pid is only the process it was: a different start time is someone else's process", () => {
  const me = procStat(process.pid)!;
  expect(procAlive(process.pid, me.start)).toBe(true);
  expect(procAlive(process.pid, String(Number(me.start) + 1))).toBe(false);
  expect(procAlive(2 ** 22 + 12345)).toBe(false);
});

test('only what it reaches: TypeScript of a reached package it never imports leaves it; the lock file, Bun and the environment count', () => {
  const before = fp().hash;
  put('packages/shared/src/unused.ts', 'export const unused = 1;\n');
  expect(fp().hash).toBe(before);
  put('packages/shared/src/page.js', '// read as a file\n');
  const withAsset = fp().hash;
  expect(withAsset).not.toBe(before);
  // bun.lock: only the entries of what it reaches (left-pad and what left-pad depends on), not the whole file.
  const lock = (padIntegrity: string, depVersion: string, other: string) =>
    `{\n  "lockfileVersion": 2,\n  "workspaces": { "": { "name": "ws", }, },\n  "packages": {\n    "left-pad": ["left-pad@1.3.0", "", { "dependencies": { "dep": "^1.0.0" } }, "sha512-${padIntegrity}"],\n    "dep": ["dep@${depVersion}", "", {}, "sha512-d"],\n    "other": ["other@${other}", "", {}, "sha512-o"],\n  },\n}\n`;
  put('bun.lock', lock('a', '1.0.0', '1.0.0'));
  const withLock = fp().hash;
  expect(withLock).not.toBe(withAsset);
  put('bun.lock', lock('a', '1.0.0', '2.0.0'));
  expect(fp().hash).toBe(withLock);
  put('package.json', JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*', 'extractors/*'], devDependencies: { typescript: '^6' }, scripts: { x: 'y' } }));
  expect(fp().hash).toBe(withLock);
  put('bun.lock', lock('a', '1.0.1', '1.0.0'));
  expect(fp().hash).not.toBe(withLock);
  put('bun.lock', lock('b', '1.0.0', '1.0.0'));
  expect(fp().hash).not.toBe(withLock);
  put('bun.lock', lock('a', '1.0.0', '1.0.0'));
  expect(fp().hash).toBe(withLock);
  expect(lockEntries({ packages: { 'left-pad': ['left-pad@1.3.0', '', { dependencies: { dep: '1' } }, 'sha512-a'], 'left-pad/dep': ['dep@0.9.0', '', {}, 'sha512-n'], dep: ['dep@1.0.0', '', {}, 'sha512-d'] } }, ['left-pad'])).toEqual(['dep@0.9.0 sha512-n', 'left-pad@1.3.0 sha512-a']);
  const env = (e: Record<string, string>) => fingerprintEntry(root, join(root, 'extractors/x/src/main.ts'), e).hash;
  // Per account or per start (its id, token, the manager's port), and the manager's own settings: not the code.
  expect(env({ DITHER_ACCOUNT_ID: 'acc-1', DITHER_HUB_URL: 'ws://127.0.0.1:1/x', DITHER_ACCOUNTS_PORT: '1' })).toBe(withLock);
  expect(env({ DITHER_TELEGRAM_DESKTOP: '1' })).not.toBe(withLock);
  expect(env({ PATH: '/opt/bin' })).not.toBe(withLock);
  expect(Object.keys(codeEnv({ DITHER_TELEGRAM_DESKTOP: '1', DITHER_ADAPTER_TOKEN: 't', DITHER_MARKER_KEY: 'k', HOME: '/x', PATH: '/p' })).sort()).toEqual(['DITHER_TELEGRAM_DESKTOP', 'PATH']);
});

test('an unknown fingerprint is never the same code', () => {
  expect(sameCode('abc', 'abc')).toBe(true);
  expect(sameCode('abc', 'abd')).toBe(false);
  expect(sameCode('unknown: x', 'unknown: x')).toBe(false);
  expect(sameCode('', '')).toBe(false);
  expect(sameCode(undefined, 'abc')).toBe(false);
});
