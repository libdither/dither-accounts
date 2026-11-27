/**
 * The sandboxes' programs (src/bins.ts): a pinned one comes from the prepared directory (DITHER_BINS), never from a
 * `nix build` in the process that runs it, and is refused at once, saying how to prepare it, when it is not there. And
 * the one list of what is prepared (nix/bins.json) is the list of pinned specs.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_BINS } from '../../../test/needs.ts';
import { BINS } from '../../sandbox/src/bins.ts';
import { DISPLAY_BACKENDS, fromFork } from '@dither-accounts/spec/display';
import { BACKEND_BINS, BinNotPrepared, type BinSpec, DISPLAY_BINS, preparedBin, resolveBin } from '../src/bins.ts';
import { CHROMIUM } from '../src/sandbox.ts';
import { SHARE_BINS } from '../src/screenshare.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-bins-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('nix/bins.json lists exactly the pinned specs: the run and forks lists the sandboxes, the test list the tests', () => {
  const list = JSON.parse(readFileSync(join(import.meta.dir, '../../../nix/bins.json'), 'utf8')) as { run: string[]; forks: string[]; test: string[] };
  const pinned = (specs: Record<string, BinSpec>) => Object.values(specs).filter((s) => s.pinned).map((s) => s.nix);
  const run = new Set([...pinned(DISPLAY_BINS), ...pinned(SHARE_BINS), ...pinned(BINS), ...pinned({ CHROMIUM })]);
  expect([...new Set([...list.run, ...list.forks])].sort()).toEqual([...run].sort());
  expect(list.run.length + list.forks.length).toBe(new Set([...list.run, ...list.forks]).size);
  // The forks' build is what only the backends built from forks start: each of those needs it, nothing else does.
  const forkOnly = new Set(DISPLAY_BACKENDS.filter(fromFork).flatMap((b) => BACKEND_BINS[b].map((s) => s.nix)));
  for (const b of DISPLAY_BACKENDS.filter((b) => !fromFork(b))) for (const s of BACKEND_BINS[b]) forkOnly.delete(s.nix);
  expect([...list.forks].sort()).toEqual([...forkOnly].sort());
  expect([...list.test].sort()).toEqual(pinned(TEST_BINS).sort());
  // Every program the screens and the sandbox start is pinned.
  for (const s of [...Object.values(DISPLAY_BINS), ...Object.values(SHARE_BINS), ...Object.values(BINS), CHROMIUM]) expect(s.pinned).toBe(true);
});

test('a pinned program: its override, then the prepared package (a link per attribute), else an error that says how to prepare it', () => {
  const store = tmp();
  const pkg = join(store, 'pkg-sway');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'bin', 'fakeprog'), '#!/bin/sh\n', { mode: 0o755 });
  mkdirSync(join(pkg, 'libexec'));
  writeFileSync(join(pkg, 'libexec', 'fakeportal'), '#!/bin/sh\n', { mode: 0o755 });
  const prepared = tmp();
  symlinkSync(pkg, join(prepared, 'fake-attr'));
  const spec: BinSpec = { name: 'fakeprog', env: 'FAKEPROG_BIN_FOR_TEST', nix: 'fake-attr', path: false, pinned: true };
  expect(preparedBin(spec, prepared)).toBe(join(pkg, 'bin', 'fakeprog'));
  expect(preparedBin({ ...spec, name: 'fakeportal', sub: 'libexec' }, prepared)).toBe(join(pkg, 'libexec', 'fakeportal'));
  expect(preparedBin({ ...spec, nix: 'other-attr' }, prepared)).toBeNull();
  expect(preparedBin(spec, undefined)).toBeNull();
  // DITHER_BINS is a list (the forks' servers are a build of their own): the first directory that has it.
  const other = tmp();
  expect(preparedBin(spec, `${other}:${prepared}`)).toBe(join(pkg, 'bin', 'fakeprog'));
  expect(preparedBin(spec, `${other}::`)).toBeNull();

  const was = process.env.DITHER_BINS;
  try {
    process.env.DITHER_BINS = prepared;
    expect(resolveBin(spec, () => {})).toBe(join(pkg, 'bin', 'fakeprog'));
    const missing: BinSpec = { name: 'nosuchprog-dither', env: 'NOSUCHPROG_BIN_FOR_TEST', nix: 'no-such-attr', pinned: true };
    const logs: string[] = [];
    expect(() => resolveBin(missing, (_l, m) => logs.push(m))).toThrow(BinNotPrepared);
    expect(() => resolveBin(missing, () => {})).toThrow(/nosuchprog-dither is not prepared: .* has no no-such-attr with bin\/nosuchprog-dither.*prepare-bins/);
    // Never a nix build for it.
    expect(logs.filter((m) => /nix build/.test(m))).toEqual([]);
    delete process.env.DITHER_BINS;
    expect(() => resolveBin(missing, () => {})).toThrow(/DITHER_BINS is not set/);
    // A program that is not pinned (a native app: the machine's own install) and is not there: an error at once,
    // never a build.
    const app: BinSpec = { name: 'nosuchapp-dither', env: 'NOSUCHAPP_BIN_FOR_TEST', nix: 'no-such-app' };
    expect(() => resolveBin(app, (_l, m) => logs.push(m))).toThrow(/nosuchapp-dither is not installed here: .*no-such-app.*NOSUCHAPP_BIN_FOR_TEST/);
    expect(logs.filter((m) => /nix build/.test(m))).toEqual([]);
  } finally {
    if (was === undefined) delete process.env.DITHER_BINS;
    else process.env.DITHER_BINS = was;
  }
});
