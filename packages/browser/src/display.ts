/**
 * A free X display for a new sandbox: the first n in a range (default :80–:89, then :100–:159) with no X socket, no X
 * lock file and no live claim (below). Discord's sandboxes keep their own hashed :91–:99. Ten displays were not enough
 * once eight accounts had live views and a test manager wanted four more. A display's live view is a Unix socket in
 * its account's directory (vnc.ts), so it has no port to find free.
 */
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface FreeDisplay {
  display: number;
}

/** True if something already listens on the port at this host. A host this machine lacks (no IPv6) counts as free. */
export function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(false)));
  });
}

export function displayTaken(n: number): boolean {
  return existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`);
}

/** Where a sandbox's display comes from when the caller names no range, in order. */
export const DISPLAY_RANGES: readonly { from: number; to: number }[] = [
  { from: 80, to: 89 },
  { from: 100, to: 159 },
];

export async function pickFreeDisplay(range?: { from: number; to: number }, skip: number[] = []): Promise<FreeDisplay> {
  const ranges = range ? [range] : DISPLAY_RANGES;
  for (const r of ranges)
    for (let n = r.from; n <= r.to; n++) {
      if (skip.includes(n) || displayTaken(n)) continue;
      // Free by every sign, but so it is for anyone else looking at this moment: claim it, or go on.
      if (!claimDisplay(n)) continue;
      return { display: n };
    }
  throw new Error(`no free X display in ${ranges.map((r) => `:${r.from}–:${r.to}`).join(' or ')}`);
}

/**
 * Claims, so that extractors starting at the same moment don't all pick the first free display and lose to each other
 * (2026-11-09: three Google extractors and X started together; X's Xvfb lost :82 three times running). A claim is a
 * file per display number, made with O_EXCL (atomic), holding the claimer's pid and the time. It counts while that
 * process lives and for 20 s: by then its Xvfb holds the display's own lock, which displayTaken sees. A claim whose
 * process is gone, or that is older, is taken over.
 */
export const CLAIM_MS = 20_000;
const claimsDir = () => process.env.DITHER_DISPLAY_CLAIMS || '/tmp/.dither-displays';

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Claim display n for this process; false when another live claim, under 20 s old, has it. */
export function claimDisplay(n: number, now = Date.now(), pid = process.pid): boolean {
  const dir = claimsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, String(n));
  const make = () => {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, `${pid} ${now}\n`);
    } finally {
      closeSync(fd);
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      make();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: { pid: number; at: number } | null = null;
    try {
      const [p, at] = readFileSync(path, 'utf8').trim().split(/\s+/).map(Number);
      held = { pid: p, at };
    } catch {
      held = null; // gone in between, or half written: try again
    }
    if (held && Number.isFinite(held.at) && alive(held.pid) && now - held.at < CLAIM_MS) return false;
    // Stale: move it aside (rename is atomic, so of two takers only one gets it), then claim afresh.
    const aside = `${path}.${pid}.${now}.stale`;
    try {
      renameSync(path, aside);
      unlinkSync(aside);
    } catch {
      // Someone else took it over first; the next make() says who won.
    }
  }
  return false;
}
