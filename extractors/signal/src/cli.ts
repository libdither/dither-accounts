/**
 * Locating and running signal-cli.
 *
 * Binary: $SIGNAL_CLI_BIN, else `signal-cli` on PATH, else
 * `nix build nixpkgs#signal-cli --no-link --print-out-paths` (cached in the
 * account dir so later starts skip the evaluation).
 *
 * Every child we start is recorded in <accountDir>/signal-cli.pids. If the
 * adapter is SIGKILLed its children survive and keep signal-cli's account
 * lock (a new daemon would wait on it forever), so the next adapter start
 * kills recorded processes whose command line still points at our data dir.
 */

import type { Subprocess } from 'bun';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface Logger {
  (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
}

function isExecutable(p: string) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

const CACHE_TTL_MS = 7 * 86_400_000;

/** Resolve the signal-cli command (argv prefix). */
export async function resolveSignalCli(cacheFile: string | null, log: Logger): Promise<string[]> {
  const env = process.env.SIGNAL_CLI_BIN?.trim();
  if (env) {
    // Allow "bun /path/fake.ts" style overrides (tests) as well as a plain path.
    const parts = env.split(/\s+/);
    if (parts.length > 1 || isExecutable(parts[0])) return parts;
    throw new Error(`SIGNAL_CLI_BIN=${env} is not executable`);
  }
  const onPath = findOnPath('signal-cli');
  if (onPath) return [onPath];
  // Signal stops talking to old clients after a few months, so re-resolve weekly to pick up nixpkgs updates.
  if (cacheFile && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < CACHE_TTL_MS) {
    const cached = readFileSync(cacheFile, 'utf8').trim();
    if (isExecutable(cached)) return [cached];
  }
  log('info', 'signal-cli not on PATH; building nixpkgs#signal-cli');
  const nix = findOnPath('nix') ?? '/run/current-system/sw/bin/nix';
  const proc = Bun.spawn([nix, 'build', 'nixpkgs#signal-cli', '--no-link', '--print-out-paths'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const store = out.trim().split('\n').filter(Boolean).pop();
  const bin = store ? join(store, 'bin', 'signal-cli') : '';
  if (code !== 0 || !isExecutable(bin)) {
    throw new Error(`could not find signal-cli (set SIGNAL_CLI_BIN or put it on PATH): nix build exited ${code}: ${err.trim().split('\n').pop() ?? ''}`);
  }
  if (cacheFile) writeFileSync(cacheFile, bin + '\n');
  return [bin];
}

// ------------------------------------------------------------------ child bookkeeping

export class ChildRegistry {
  private live = new Map<number, Subprocess>();

  constructor(
    private pidFile: string,
    /** Substring that identifies our children in /proc/<pid>/cmdline (the signal-cli data dir). */
    private marker: string,
    private log: Logger,
  ) {
    process.on('exit', () => {
      for (const [pid] of this.live) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    });
  }

  add(p: Subprocess) {
    this.live.set(p.pid, p);
    this.save();
    p.exited.then(() => {
      this.live.delete(p.pid);
      this.save();
    });
  }

  private save() {
    try {
      writeFileSync(this.pidFile, JSON.stringify([...this.live.keys()]));
    } catch {}
  }

  /** Kill children left behind by a previous adapter process. */
  async reapOrphans() {
    if (!existsSync(this.pidFile)) return;
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.pidFile, 'utf8'));
    } catch {}
    for (const pid of pids) {
      if (this.live.has(pid)) continue;
      let cmdline = '';
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      } catch {
        continue; // gone
      }
      if (!cmdline.includes(this.marker)) continue;
      this.log('warn', `killing orphaned signal-cli process ${pid}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 50 && existsSync(`/proc/${pid}`); i++) await Bun.sleep(100);
      try {
        if (existsSync(`/proc/${pid}`)) process.kill(pid, 'SIGKILL');
      } catch {}
    }
    this.save();
  }

  async killAll(graceMs = 5000) {
    await Promise.all([...this.live.values()].map((p) => stopProcess(p, graceMs)));
  }
}

/** SIGTERM, then SIGKILL after a grace period. */
export async function stopProcess(p: Subprocess, graceMs = 5000) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  try {
    p.kill('SIGTERM');
  } catch {}
  const killer = setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch {}
  }, graceMs);
  await p.exited.catch(() => {});
  clearTimeout(killer);
}

/** Read a stream line by line. Resolves when the stream ends. */
export async function readLines(stream: ReadableStream<Uint8Array> | null | undefined, onLine: (line: string) => void) {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // Keep draining even if a handler throws, or the child blocks on a full pipe.
  const emit = (line: string) => {
    try {
      onLine(line);
    } catch (e) {
      console.error('[signal] line handler failed', e);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        emit(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
  } catch {}
  if (buf) emit(buf);
}

/** For logs: keep the shape of a link URI, drop the key material. */
export function redactLinkUri(s: string): string {
  return s.replace(/(sgnl:\/\/linkdevice\?)\S+/g, (_m, head) => `${head}uuid=…&pub_key=…`);
}
