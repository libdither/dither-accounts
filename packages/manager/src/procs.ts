/**
 * What the supervisor reads of other processes in /proc: whether a pid is still the process it was (its start time, so
 * a pid the kernel handed to someone else is not taken for it), its environment and command line. Linux only; on a
 * machine without /proc every process looks gone.
 */
import { readdirSync, readFileSync } from 'node:fs';

/** A process's start, in clock ticks after boot (/proc/<pid>/stat field 22), its state letter, parent and group. */
export function procStat(pid: number): { start: string; state: string; ppid: number; pgrp: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid …: comm may hold spaces and parentheses, so fields count from the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0] ?? '', start: rest[19] ?? '', ppid: Number(rest[1]), pgrp: Number(rest[2]) };
  } catch {
    return null;
  }
}

/** Whether `pid` runs and is the process that started at `start` (when given); a zombie has ended. */
export function procAlive(pid: number, start?: string): boolean {
  const s = procStat(pid);
  if (!s || s.state === 'Z' || s.state === 'X') return false;
  return start === undefined || s.start === start;
}

/** A process's environment (its own at exec, as the kernel keeps it), or null when it cannot be read. */
export function procEnv(pid: number): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}

export function procCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

let bootMs: number | null = null;
/** When a process started, in ms since the epoch, from its start in ticks (USER_HZ is 100 on Linux). */
export function procStartedAt(start: string): number | null {
  if (bootMs === null) {
    try {
      const m = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
      bootMs = m ? Number(m[1]) * 1000 : 0;
    } catch {
      bootMs = 0;
    }
  }
  const ticks = Number(start);
  return bootMs && Number.isFinite(ticks) ? bootMs + ticks * 10 : null;
}

/** Every pid in /proc. */
export function allPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return [];
  }
}

/** A live process, named by pid and start (so a pid handed on is never taken for it). */
export interface ProcRef {
  pid: number;
  start: string;
}

const ref = (pid: number): ProcRef | null => {
  const s = procStat(pid);
  return s && s.state !== 'Z' && s.state !== 'X' ? { pid, start: s.start } : null;
};

/** A process's descendants (children, theirs…), as /proc shows them now. */
export function descendants(root: number): ProcRef[] {
  const children = new Map<number, number[]>();
  for (const pid of allPids()) {
    const s = procStat(pid);
    if (s) (children.get(s.ppid) ?? children.set(s.ppid, []).get(s.ppid)!).push(pid);
  }
  const out: ProcRef[] = [];
  const todo = [...(children.get(root) ?? [])];
  while (todo.length && out.length < 10_000) {
    const pid = todo.pop()!;
    const r = ref(pid);
    if (r) out.push(r);
    todo.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** The processes of a process group. */
export function groupMembers(pgid: number): ProcRef[] {
  const out: ProcRef[] = [];
  for (const pid of allPids()) {
    const s = procStat(pid);
    if (s && s.pgrp === pgid && s.state !== 'Z') out.push({ pid, start: s.start });
  }
  return out;
}

/** A process's control group (cgroup v2: `/user.slice/…/name.scope`), or null. */
export function cgroupOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}

/** The processes in a control group (cgroup v2), or none when it is gone. */
export function cgroupMembers(path: string): ProcRef[] {
  try {
    return readFileSync(`/sys/fs/cgroup${path}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((p) => ref(Number(p)))
      .filter((r): r is ProcRef => !!r);
  } catch {
    return [];
  }
}

/** Processes whose environment `match` accepts. */
export function procsWithEnv(match: (env: Record<string, string>) => boolean): ProcRef[] {
  const out: ProcRef[] = [];
  for (const pid of allPids()) {
    if (pid === process.pid) continue;
    const env = procEnv(pid);
    if (!env || !match(env)) continue;
    const r = ref(pid);
    if (r) out.push(r);
  }
  return out;
}

/** Signal a process only while it is still the one that started at `start`. */
export function signalRef(p: ProcRef, sig: NodeJS.Signals): boolean {
  if (!procAlive(p.pid, p.start)) return false;
  try {
    process.kill(p.pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM to each, SIGKILL after `graceMs` to those left; resolves once they are gone (or would not go). */
export async function endAll(procs: ProcRef[], graceMs = 3000): Promise<void> {
  const left = () => procs.filter((p) => procAlive(p.pid, p.start));
  for (const p of left()) signalRef(p, 'SIGTERM');
  const until = async (ms: number) => {
    const end = Date.now() + ms;
    while (left().length && Date.now() < end) await Bun.sleep(100);
  };
  await until(graceMs);
  for (const p of left()) signalRef(p, 'SIGKILL');
  await until(2000);
}

// ---------------------------------------------------------------- systemd

/**
 * The systemd user service this process is the main process of (its control group is `<name>.service` and the unit's
 * MainPID is this pid), or null: a shell or a script started from inside a service, which inherits its INVOCATION_ID,
 * is not it.
 */
export function ownService(pid = process.pid, mainPid: (unit: string) => number | null = systemdMainPid): string | null {
  const cg = cgroupOf(pid);
  const unit = cg?.split('/').pop() ?? '';
  if (!unit.endsWith('.service')) return null;
  return mainPid(unit) === pid ? unit : null;
}

function systemdMainPid(unit: string): number | null {
  try {
    const r = Bun.spawnSync(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', unit], { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
    return r.exitCode === 0 ? Number(r.stdout.toString().trim()) || null : null;
  } catch {
    return null;
  }
}

/**
 * Whether systemd is restarting `unit` (its job is a restart), rather than stopping it: on SIGTERM the manager leaves
 * its extractors running only for a restart. A job line is "<id> <unit> <type> <state>".
 */
export function restartQueued(unit: string, jobs: () => string = listJobs): boolean {
  return jobs()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .some((f) => f[1] === unit && /^(restart|try-restart|reload-or-restart|try-reload-or-restart)$/.test(f[2] ?? ''));
}

function listJobs(): string {
  try {
    const r = Bun.spawnSync(['systemctl', '--user', 'list-jobs', '--no-legend', '--plain'], { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
    return r.exitCode === 0 ? r.stdout.toString() : '';
  } catch {
    return '';
  }
}
