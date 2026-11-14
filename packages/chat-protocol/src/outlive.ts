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

/**
 * The link's side of a manager's restart (dither-accounts docs/supervisor.md "Handing over"):
 * - `manager-going` from the manager: from then on every event waits in the link's queue for the next manager, and
 *   `holding` goes back at once (after every frame sent before it, so the going manager has them all);
 * - back on a new socket: `resumed` first, saying whether it was holding when the old socket closed (nothing lost)
 *   or not (events sent on the old socket may not have arrived: the manager has apps hear of a gap).
 * Kept here, not in adapter-client.ts (a copy of dither-chat's protocol package), so a sync of that copy does not
 * drop it; test/outlive.test.ts fails if a link stops answering.
 */
export function managerHandshake() {
  let going = false;
  let opened = false;
  let heldAtClose = false;
  /** Its queue overflowed since the last socket: events were dropped, whatever it held. */
  let lost = false;
  return {
    /** Events wait for the next manager. */
    get holding() {
      return going;
    },
    /** A socket opened: call before flushing the queue. */
    opened(ws: { send(s: string): void }) {
      if (opened) ws.send(JSON.stringify({ t: 'resumed', held: heldAtClose && !lost }));
      opened = true;
      going = false;
      lost = false;
    },
    /** The queue dropped events (it overflowed): the next `resumed` says they were not held. */
    dropped() {
      lost = true;
    },
    closed() {
      heldAtClose = going;
    },
    /** A message from the manager: true when it was the handshake's (and is answered). */
    message(m: { t?: unknown } | null | undefined, ws: { send(s: string): void } | null): boolean {
      if (m?.t !== 'manager-going') return false;
      going = true;
      ws?.send(JSON.stringify({ t: 'holding' }));
      return true;
    },
  };
}
