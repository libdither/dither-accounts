#!/usr/bin/env bun
/**
 * How much memory each account's browser takes: PSS (proportional set size, so shared pages are split between the
 * processes that map them and the totals add up) of the root Chromium and every process under it, grouped by the root's
 * --user-data-dir. Only the root is sure to carry that flag, so every other Chromium process is put with the root it
 * descends from (walking the parent chain). Reads /proc only; touches no browser.
 *
 *   bun scripts/mem.ts            one line per account, biggest first, with a total
 *   bun scripts/mem.ts --procs    and each process under it (type, PSS)
 *   bun scripts/mem.ts --json     the same as JSON
 *
 * Linux only. PSS comes from /proc/<pid>/smaps_rollup, which needs the processes to be yours (or root).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface Proc {
  pid: number;
  ppid: number;
  args: string[];
}

export interface ProcMem {
  pid: number;
  /** browser, renderer, extension, gpu, utility:<sub-type>, zygote, crashpad, other */
  type: string;
  pssKiB: number;
}

export interface BrowserMem {
  /** The account's directory name (the profile's parent), or the profile path when it is not in an account directory. */
  account: string;
  /** The extractor's kind, from the parent process's extractors/<kind>/ path, when there is one. */
  kind: string | null;
  profile: string;
  rootPid: number;
  pssKiB: number;
  byType: Record<string, { count: number; pssKiB: number }>;
  procs: ProcMem[];
}

function readArgs(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter(Boolean);
    // Chromium rewrites its process title: the whole command line becomes one space-separated string.
    return args.length === 1 && args[0]!.includes(' --') ? args[0]!.split(' ') : args.length ? args : null;
  } catch {
    return null;
  }
}

function readPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

/** PSS in KiB, or 0 when the process is gone or not readable. */
export function pssKiB(pid: number): number {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

export function listProcs(): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const args = readArgs(pid);
    const ppid = readPpid(pid);
    if (args && ppid !== null) out.push({ pid, ppid, args });
  }
  return out;
}

const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const isChromium = (p: Proc) => /chrom(e|ium)/i.test(basename(p.args[0] ?? ''));

export function procType(args: string[]): string {
  const type = flag(args, 'type');
  if (!type) return 'browser';
  if (type === 'renderer') return args.includes('--extension-process') ? 'extension' : 'renderer';
  if (type === 'gpu-process') return 'gpu';
  if (type === 'utility') return `utility:${(flag(args, 'utility-sub-type') ?? '?').replace(/\.mojom\..*$/, '')}`;
  if (type === 'zygote' || type === 'crashpad-handler') return type === 'zygote' ? 'zygote' : 'crashpad';
  return type;
}

/** Group Chromium processes under their root browser (a Chromium with --user-data-dir and no --type). */
export function groupBrowsers(procs: Proc[], pss: (pid: number) => number = pssKiB): BrowserMem[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const roots = new Map<number, BrowserMem>();
  for (const p of procs) {
    if (!isChromium(p) || flag(p.args, 'type')) continue;
    const profile = flag(p.args, 'user-data-dir');
    if (!profile) continue;
    const parent = byPid.get(p.ppid);
    const kind = parent?.args.map((a) => /extractors\/([^/]+)\//.exec(a)?.[1]).find(Boolean) ?? null;
    roots.set(p.pid, { account: basename(profile) === 'profile' ? basename(dirname(profile)) : profile, kind, profile, rootPid: p.pid, pssKiB: 0, byType: {}, procs: [] });
  }
  for (const p of procs) {
    // Crashpad is started by the browser but reparents to init; it names its browser in --database.
    let root: BrowserMem | undefined;
    for (let cur: Proc | undefined = p, hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) {
      root = roots.get(cur.pid);
      if (root) break;
    }
    if (!root && isChromium(p) && flag(p.args, 'type') === 'crashpad-handler') {
      const db = flag(p.args, 'database');
      root = [...roots.values()].find((r) => db && db.startsWith(r.profile));
    }
    if (!root || !isChromium(p)) continue;
    const mem: ProcMem = { pid: p.pid, type: procType(p.args), pssKiB: pss(p.pid) };
    root.procs.push(mem);
    root.pssKiB += mem.pssKiB;
    const t = (root.byType[mem.type] ??= { count: 0, pssKiB: 0 });
    t.count++;
    t.pssKiB += mem.pssKiB;
  }
  return [...roots.values()].sort((a, b) => b.pssKiB - a.pssKiB);
}

const mib = (kib: number) => `${(kib / 1024).toFixed(0)} MiB`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const browsers = groupBrowsers(listProcs());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(browsers, null, 2));
  } else {
    const total = browsers.reduce((s, b) => s + b.pssKiB, 0);
    const types = new Map<string, { count: number; pssKiB: number }>();
    for (const b of browsers) {
      const parts = Object.entries(b.byType)
        .sort((x, y) => y[1].pssKiB - x[1].pssKiB)
        .map(([t, v]) => `${t}${v.count > 1 ? `×${v.count}` : ''} ${mib(v.pssKiB)}`);
      console.log(`${mib(b.pssKiB).padStart(9)}  ${(b.kind ?? '?').padEnd(10)} ${b.account}  [${parts.join(', ')}]`);
      if (argv.includes('--procs')) for (const p of b.procs) console.log(`             ${String(p.pid).padStart(8)} ${p.type.padEnd(24)} ${mib(p.pssKiB)}`);
      for (const [t, v] of Object.entries(b.byType)) {
        const s = types.get(t) ?? { count: 0, pssKiB: 0 };
        types.set(t, { count: s.count + v.count, pssKiB: s.pssKiB + v.pssKiB });
      }
    }
    console.log(`${mib(total).padStart(9)}  total, ${browsers.length} browsers`);
    for (const [t, v] of [...types].sort((x, y) => y[1].pssKiB - x[1].pssKiB)) console.log(`${mib(v.pssKiB).padStart(9)}    ${t} ×${v.count}`);
  }
}
