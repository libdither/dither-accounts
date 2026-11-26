/**
 * The display backends are listed once (packages/spec display.ts BACKENDS); the places that name them by hand say
 * the same: what nix/bins.json prepares, config.example.toml's display_backend, and the CLI's usage text.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_BINS } from '../packages/browser/src/bins.ts';
import { BACKENDS, DISPLAY_BACKENDS } from '../packages/spec/src/display.ts';

const root = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const forks = DISPLAY_BACKENDS.filter((b) => (BACKENDS[b] as { experimental?: string }).experimental === 'fork');

test('nix/bins.json prepares every program each backend starts', () => {
  const lists = JSON.parse(read('nix/bins.json')) as Record<string, unknown>;
  // Every list but the tests' is something the sandboxes run.
  const run = new Set(Object.entries(lists).flatMap(([k, v]) => (k !== 'test' && Array.isArray(v) ? (v as string[]) : [])));
  for (const b of DISPLAY_BACKENDS) {
    expect(BACKEND_BINS[b].length).toBeGreaterThan(0);
    for (const spec of BACKEND_BINS[b]) expect({ backend: b, nix: spec.nix, listed: run.has(spec.nix ?? '') }).toEqual({ backend: b, nix: spec.nix, listed: true });
  }
});

test("config.example.toml's display_backend names every backend, the forks' after \"experimental\"", () => {
  const lines = read('config.example.toml').split('\n');
  const at = lines.findIndex((l) => /^display_backend\s*=/.test(l));
  expect(at).toBeGreaterThan(-1);
  // The setting's line and the comment lines under it.
  const block = [lines[at]!.replace(/^[^#]*#/, '')];
  for (let i = at + 1; i < lines.length && /^\s+#/.test(lines[i]!); i++) block.push(lines[i]!.replace(/^\s+#/, ''));
  const text = block.join(' ');
  const named = [...text.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
  expect(sorted(named)).toEqual(sorted(DISPLAY_BACKENDS));
  const experimental = text.indexOf('experimental');
  expect(experimental).toBeGreaterThan(-1);
  for (const b of DISPLAY_BACKENDS) expect({ b, afterExperimental: text.indexOf(`"${b}"`) > experimental }).toEqual({ b, afterExperimental: forks.includes(b) });
});

test("the CLI's usage text names every backend for `display`", () => {
  const usage = read('packages/manager/src/cli.ts').split('\n').find((l) => /cli\.ts display </.test(l));
  expect(usage).toBeDefined();
  const list = usage!.match(/draw on: ([^(]+)\(/)?.[1];
  expect(list).toBeDefined();
  const named = list!.split(/,\s*|\s+or\s+/).map((s) => s.trim()).filter(Boolean);
  expect(sorted(named)).toEqual(sorted(DISPLAY_BACKENDS));
});
