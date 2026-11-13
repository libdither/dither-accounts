/**
 * A stand-in for `t3 thread start --json`, for tests: it keeps its argv and stdin in the directory given as its first
 * argument (call-<n>.json), then answers as the real one does ({ threadId, runId }), or fails with the exit code in
 * that directory's `fail` file.
 *
 *   bun fake-t3.ts <dir> <the rest of the argv…>     (the brief on stdin)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...rest] = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const n = readdirSync(dir!).filter((f) => f.startsWith('call-')).length + 1;
writeFileSync(join(dir!, `call-${n}.json`), JSON.stringify({ argv: rest, stdin }));
const fail = join(dir!, 'fail');
if (existsSync(fail)) {
  console.error('error: the fake thread command was told to fail');
  process.exit(Number(readFileSync(fail, 'utf8').trim()) || 1);
}
console.log(JSON.stringify({ threadId: `thread-${n}`, runId: `run-${n}` }));
