/** Running the thread command: argv only (never a shell), the brief on stdin, a time limit, its output kept short. */
import type { RunResult } from './watch.ts';

const MAX_OUT = 64 * 1024;

export async function run(argv: string[], stdin: string, timeoutMs: number): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 5000).unref?.();
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(-MAX_OUT), ...(timedOut ? { timedOut } : {}) };
}
