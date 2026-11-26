#!/usr/bin/env bun
/**
 * How much memory each account takes: every process its extractor runs (the extractor itself, its Chromium and every
 * process under it, signal-cli, a native app's sandbox with its Xvfb and x11vnc), counted twice over:
 *
 * - PSS (proportional set size): what it holds in RAM, shared pages split between the processes that map them, so the
 *   totals add up.
 * - Swap: what it holds in swap. On a machine short of memory most of an idle browser lives there, and a count of PSS
 *   alone misses it. Under zram, swap costs RAM too, at its compressed size.
 *
 * A process belongs to an account when its environment names one (DITHER_ACCOUNT_ID, with the manager's
 * DITHER_MANAGER_DATA), when an ancestor's does, or when it shares the control group of a process that does: a
 * native-app sandbox clears its environment, and in a `scope` launch every process of the account is in its scope.
 * Chromium's crashpad handler reparents to init; it names its browser's profile in --database. Processes of no account
 * (another program's browser, say) are left out. Reads /proc only; touches no process.
 *
 *   bun scripts/mem.ts                 one line per account, biggest first, with totals by process type
 *   bun scripts/mem.ts --procs         and each process under it
 *   bun scripts/mem.ts --json          the same as JSON
 *   bun scripts/mem.ts --data <dir>    only the accounts of the manager on this data directory
 *
 * Linux only. PSS and swap come from /proc/<pid>/smaps_rollup, which needs the processes to be yours (or root).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface Proc {
  pid: number;
  ppid: number;
  args: string[];
  /** DITHER_ACCOUNT_ID and DITHER_MANAGER_DATA from its environment, when it has them. */
  account?: string;
  data?: string;
  /** Its control group (the last line of /proc/<pid>/cgroup). */
  cgroup?: string;
}

export interface Mem {
  pssKiB: number;
  swapKiB: number;
}

export interface ProcMem extends Mem {
  pid: number;
  /** extractor, browser, renderer, extension, gpu, utility:<sub-type>, zygote, crashpad, signal-cli, electron:<type>, Xvfb, x11vnc, or the program's name */
  type: string;
}

export interface AccountMem extends Mem {
  account: string;
  /** The extractor's kind, from its extractors/<kind>/ path, when there is one. */
  kind: string | null;
  data: string | null;
  byType: Record<string, Mem & { count: number }>;
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

function readEnv(pid: number): { account?: string; data?: string } {
  try {
    const out: { account?: string; data?: string } = {};
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (kv.startsWith('DITHER_ACCOUNT_ID=')) out.account = kv.slice(18);
      else if (kv.startsWith('DITHER_MANAGER_DATA=')) out.data = kv.slice(20);
    }
    return out;
  } catch {
    return {};
  }
}

function readCgroup(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').pop()?.replace(/^\d*::?/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** PSS and swap in KiB, or 0 when the process is gone or not readable. */
export function memOf(pid: number): Mem {
  try {
    const s = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    return { pssKiB: Number(/^Pss:\s+(\d+) kB/m.exec(s)?.[1] ?? 0), swapKiB: Number(/^Swap:\s+(\d+) kB/m.exec(s)?.[1] ?? 0) };
  } catch {
    return { pssKiB: 0, swapKiB: 0 };
  }
}

export function listProcs(): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const args = readArgs(pid);
    const ppid = readPpid(pid);
    if (args && ppid !== null) out.push({ pid, ppid, args, ...readEnv(pid), cgroup: readCgroup(pid) });
  }
  return out;
}

const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const program = (p: Proc) => basename(p.args[0] ?? '');
const isChromium = (p: Proc) => /chrom(e|ium)/i.test(program(p));
const kindOf = (args: string[]) => args.map((a) => /extractors\/([^/]+)\//.exec(a)?.[1]).find(Boolean) ?? null;

/** Chromium's process type from its switches. */
export function chromiumType(args: string[]): string {
  if (/crashpad/.test(basename(args[0] ?? ''))) return 'crashpad';
  const type = flag(args, 'type');
  if (!type) return 'browser';
  if (type === 'renderer') return args.includes('--extension-process') ? 'extension' : 'renderer';
  if (type === 'gpu-process') return 'gpu';
  if (type === 'utility') return `utility:${(flag(args, 'utility-sub-type') ?? '?').replace(/\.mojom\..*$/, '')}`;
  if (type === 'zygote' || type === 'crashpad-handler') return type === 'zygote' ? 'zygote' : 'crashpad';
  return type;
}

/** What a process of an account is. */
export function procType(p: Proc): string {
  const prog = program(p);
  if (isChromium(p)) return chromiumType(p.args);
  if (/^electron$/i.test(prog)) return `electron:${chromiumType(p.args)}`;
  if (/^(bun|node)$/.test(prog) && kindOf(p.args)) return 'extractor';
  if (prog === 'java' && p.args.some((a) => /signal-cli/.test(a))) return 'signal-cli';
  return prog || '?';
}

/** Put each process with the account it runs for (see the head of this file); processes of no account are left out. */
export function groupAccounts(procs: Proc[], mem: (pid: number) => Mem = memOf): AccountMem[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const accounts = new Map<string, AccountMem>();
  const key = (account: string, data: string | undefined) => `${data ?? ''}\0${account}`;
  const ensure = (account: string, data: string | undefined) => {
    const k = key(account, data);
    let a = accounts.get(k);
    if (!a) accounts.set(k, (a = { account, kind: null, data: data ?? null, pssKiB: 0, swapKiB: 0, byType: {}, procs: [] }));
    return a;
  };
  // Who each process belongs to: its own environment, else the nearest ancestor's.
  const owner = new Map<number, AccountMem>();
  const ownerOf = (p: Proc): AccountMem | undefined => {
    for (let cur: Proc | undefined = p, hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) {
      if (owner.has(cur.pid)) return owner.get(cur.pid);
      if (cur.account) return ensure(cur.account, cur.data);
    }
    return undefined;
  };
  for (const p of procs) {
    const a = ownerOf(p);
    if (a) owner.set(p.pid, a);
  }
  // The rest: a systemd scope an account's process is in (a `scope` launch gives each account its own; one that two
  // accounts share names neither), or a crashpad handler naming a profile one of its browsers runs on.
  const cgroups = new Map<string, AccountMem | null>();
  for (const [pid, a] of owner) {
    const cg = byPid.get(pid)?.cgroup;
    if (cg?.endsWith('.scope')) cgroups.set(cg, cgroups.has(cg) && cgroups.get(cg) !== a ? null : a);
  }
  const profiles: [string, AccountMem][] = [];
  for (const [pid, a] of owner) {
    const p = byPid.get(pid)!;
    const dir = isChromium(p) && !flag(p.args, 'type') ? flag(p.args, 'user-data-dir') : undefined;
    if (dir) profiles.push([dir, a]);
  }
  for (const p of procs) {
    if (owner.has(p.pid)) continue;
    let a = p.cgroup ? cgroups.get(p.cgroup) ?? undefined : undefined;
    if (!a && isChromium(p) && flag(p.args, 'type') === 'crashpad-handler') {
      const db = flag(p.args, 'database');
      a = db ? profiles.find(([dir]) => db.startsWith(dir))?.[1] : undefined;
    }
    if (a) owner.set(p.pid, a);
  }
  for (const p of procs) {
    const a = owner.get(p.pid);
    if (!a) continue;
    const m = mem(p.pid);
    const type = procType(p);
    if (type === 'extractor') a.kind ??= kindOf(p.args);
    a.procs.push({ pid: p.pid, type, ...m });
    a.pssKiB += m.pssKiB;
    a.swapKiB += m.swapKiB;
    const t = (a.byType[type] ??= { count: 0, pssKiB: 0, swapKiB: 0 });
    t.count++;
    t.pssKiB += m.pssKiB;
    t.swapKiB += m.swapKiB;
  }
  const total = (m: Mem) => m.pssKiB + m.swapKiB;
  return [...accounts.values()].filter((a) => a.procs.length).sort((x, y) => total(y) - total(x));
}

const mib = (kib: number) => `${(kib / 1024).toFixed(0)} MiB`;
const both = (m: Mem) => `${mib(m.pssKiB)} + ${mib(m.swapKiB)} swap`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dataAt = argv.indexOf('--data');
  const data = dataAt >= 0 ? argv[dataAt + 1] : undefined;
  const accounts = groupAccounts(listProcs()).filter((a) => !data || a.data === data);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(accounts, null, 2));
  } else {
    const dirs = new Set(accounts.map((a) => a.data));
    if (dirs.size > 1) console.log(`accounts of ${dirs.size} managers (data directories); --data <dir> shows one:\n${[...dirs].map((d) => `  ${d ?? '?'}: ${accounts.filter((a) => a.data === d).length} accounts`).join('\n')}\n`);
    const sum: Mem = { pssKiB: 0, swapKiB: 0 };
    const types = new Map<string, Mem & { count: number }>();
    console.log(`${'RAM+swap'.padStart(9)} ${'RAM'.padStart(9)} ${'swap'.padStart(9)}  kind       account  [by type: RAM + swap]`);
    for (const a of accounts) {
      sum.pssKiB += a.pssKiB;
      sum.swapKiB += a.swapKiB;
      const parts = Object.entries(a.byType)
        .sort((x, y) => y[1].pssKiB + y[1].swapKiB - x[1].pssKiB - x[1].swapKiB)
        .map(([t, v]) => `${t}${v.count > 1 ? `×${v.count}` : ''} ${mib(v.pssKiB + v.swapKiB)}`);
      const where = dirs.size > 1 ? `  (${a.data ?? '?'})` : '';
      console.log(`${mib(a.pssKiB + a.swapKiB).padStart(9)} ${mib(a.pssKiB).padStart(9)} ${mib(a.swapKiB).padStart(9)}  ${(a.kind ?? '?').padEnd(10)} ${a.account}  [${parts.join(', ')}]${where}`);
      if (argv.includes('--procs')) for (const p of a.procs) console.log(`             ${String(p.pid).padStart(8)} ${p.type.padEnd(24)} ${both(p)}`);
      for (const [t, v] of Object.entries(a.byType)) {
        const s = types.get(t) ?? { count: 0, pssKiB: 0, swapKiB: 0 };
        types.set(t, { count: s.count + v.count, pssKiB: s.pssKiB + v.pssKiB, swapKiB: s.swapKiB + v.swapKiB });
      }
    }
    console.log(`${mib(sum.pssKiB + sum.swapKiB).padStart(9)} ${mib(sum.pssKiB).padStart(9)} ${mib(sum.swapKiB).padStart(9)}  total, ${accounts.length} accounts`);
    for (const [t, v] of [...types].sort((x, y) => y[1].pssKiB + y[1].swapKiB - x[1].pssKiB - x[1].swapKiB))
      console.log(`${mib(v.pssKiB + v.swapKiB).padStart(9)} ${mib(v.pssKiB).padStart(9)} ${mib(v.swapKiB).padStart(9)}    ${t} ×${v.count}`);
  }
}
