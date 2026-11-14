/**
 * What an extractor's link to the manager does when the extractor outlives the manager (dither-accounts
 * docs/supervisor.md): the manager restarts (a deploy) and the extractor keeps its session, reconnects and is adopted.
 * Both links (adapter-client.ts here, dither-accounts' packages/link) use these.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reconnect delays: quick, the manager is on this machine and a restart takes seconds. */
export const reconnectDelay = (attempt: number) => Math.min(5000, 250 * 2 ** attempt);

/**
 * With DITHER_MANAGER_GONE_EXIT_S (set by a manager whose extractors outlive it), an extractor that has had no manager
 * for that long ends itself (`gone`), so one is never left running forever by a manager that does not come back.
 */
export function exitWhenManagerGone(isOpen: () => boolean, gone: () => void) {
  const limitS = Number(process.env.DITHER_MANAGER_GONE_EXIT_S);
  if (!Number.isFinite(limitS) || limitS <= 0) return { up() {}, down() {} };
  let since: number | null = Date.now();
  const timer = setInterval(() => {
    if (!isOpen() && since !== null && Date.now() - since > limitS * 1000) {
      clearInterval(timer);
      console.error(`no manager for ${limitS} s: ending`);
      gone();
    }
  }, Math.min(30_000, limitS * 250));
  (timer as { unref?: () => void }).unref?.();
  return {
    up: () => {
      since = null;
    },
    down: () => {
      since ??= Date.now();
    },
  };
}

/**
 * Started by the manager (DITHER_EXTRACTOR_LAUNCH): the exit code goes in the account's directory as the process ends,
 * since a manager that adopted it is not its parent and cannot wait for it.
 */
export function recordExitCode(accountDir: string) {
  if (!process.env.DITHER_EXTRACTOR_LAUNCH) return;
  process.on('exit', (code) => {
    try {
      writeFileSync(join(accountDir, 'extractor.exit'), JSON.stringify({ pid: process.pid, code, at: Date.now() }), { mode: 0o600 });
    } catch {}
  });
}
