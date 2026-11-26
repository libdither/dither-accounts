/**
 * A kind whose extractor runs a sandbox with a screen (it depends on packages/browser or packages/sandbox, or on
 * Meta's shared browser code) says so in its manifest (`screen`), or it gets no display backend and no prepared
 * programs (supervisor.ts) and its sandbox fails to start. And a kind that says so has a screen to run.
 */
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXTRACTORS = join(import.meta.dir, '..', 'extractors');
const SCREEN_DEPS = ['@dither-accounts/browser', '@dither-accounts/sandbox', '@dither-accounts/extractor-meta'];

test('every kind that runs a sandbox has `screen` in its manifest, and only those', () => {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const kind of readdirSync(EXTRACTORS)) {
    const manifest = join(EXTRACTORS, kind, 'manifest.ts');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(join(EXTRACTORS, kind, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    const sandboxed = SCREEN_DEPS.some((d) => d in (pkg.dependencies ?? {}));
    const says = /^\s*screen:/m.test(readFileSync(manifest, 'utf8'));
    // The fake takes a backend without drawing, so the supervisor's tests can move it.
    if (sandboxed && !says) missing.push(kind);
    if (says && !sandboxed && kind !== 'fake') extra.push(kind);
  }
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
