/**
 * What the supervisor reads of other processes in /proc: whether a pid is still the process it was (its start time, so
 * a pid the kernel handed to someone else is not taken for it), its environment and command line. Linux only; on a
 * machine without /proc every process looks gone.
 */
import { readFileSync } from 'node:fs';

/** A process's start, in clock ticks after boot (/proc/<pid>/stat field 22), and its state letter. */
export function procStat(pid: number): { start: string; state: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid …: comm may hold spaces and parentheses, so fields count from the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0] ?? '', start: rest[19] ?? '' };
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
