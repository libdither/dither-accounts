#!/usr/bin/env bun
/**
 * A benchmark result file made fit to commit beside its dated page in docs/benchmarks/: nothing that describes the
 * machine (the CPU and GPU models, the memory size: only the thread count and whether there was a GPU stay), the
 * WebGL renderer reduced to its class, the native apps' own log lines dropped, and a lab run's account ids replaced
 * by `lab-1`, `lab-2`… (its labels are the test accounts' invented ones). Files written by the scripts since
 * 2026-11-26 already leave out the first two; the lab's ids are needed while it runs.
 *
 *   bun scripts/bench-scrub.ts <in.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { rendererKind } from './bench-lib.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: bun scripts/bench-scrub.ts <in.json> <out.json>');
  process.exit(2);
}
const data = JSON.parse(readFileSync(input, 'utf8'));
const ids = new Map<string, string>();
function walk(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(walk);
  if (!x || typeof x !== 'object') return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'gpuLines') continue;
    if (k === 'machine' && v && typeof v === 'object') {
      const m = v as { cpus?: number; gpu?: boolean };
      out[k] = { cpus: m.cpus, ...(m.gpu === undefined ? {} : { gpu: m.gpu }) };
    } else if (k === 'renderer' && typeof v === 'string') out[k] = rendererKind(v);
    else if (k === 'account' && typeof v === 'string') {
      if (!ids.has(v)) ids.set(v, `lab-${ids.size + 1}`);
      out[k] = ids.get(v);
    } else out[k] = walk(v);
  }
  return out;
}
writeFileSync(output, `${JSON.stringify(walk(data), null, 1)}\n`);
