/**
 * A display for a new sandbox. On an X backend (x11), a free X display: the first n in a range (default :80–:89, then
 * :100–:159) with no X socket, no X lock file and no live claim (below). Discord's sandboxes keep their own :91–:99,
 * each account's hashed slot or the next free one (extractors/discord/src/sandbox.ts). Ten displays were not enough
 * once eight accounts had live views and a test manager wanted four more. A display's live view is a Unix socket in
 * its account's directory (vnc.ts), so it has no port to find free.
 *
 * On a Wayland backend there is no pool: each sandbox's compositor has its socket in the account's own directory
 * (wayland.ts), so there is nothing shared to pick, claim or leave behind.
 */
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { backendList, DEFAULT_DISPLAY_BACKEND, DISPLAY_BACKEND_ENV, type DisplayBackend, isWaylandBackend, parseBackend, type WaylandBackend, type XBackend } from '@dither-accounts/spec/display';

export { BACKENDS, DISPLAY_BACKEND_ENV, DISPLAY_BACKENDS, type DisplayBackend, isWaylandBackend, isXBackend, parseBackend, type WaylandBackend, type XBackend } from '@dither-accounts/spec/display';

/** This process's backend: DITHER_DISPLAY_BACKEND, else x11. A value that is none of them is an error, not a quiet x11. */
export function displayBackend(env: Record<string, string | undefined> = process.env): DisplayBackend {
  const v = env[DISPLAY_BACKEND_ENV];
  if (v === undefined || v.trim() === '') return DEFAULT_DISPLAY_BACKEND;
  const b = parseBackend(v);
  if (!b) throw new Error(`${DISPLAY_BACKEND_ENV} is "${v}": it must be one of ${backendList()}`);
  return b;
}

/** A display for a sandbox: an X display number (and which X backend), or a compositor of its own, which has none. */
export type FreeDisplay = XDisplay | WaylandDisplay;
export type XDisplay = { backend: XBackend; display: number };
export type WaylandDisplay = { backend: WaylandBackend; display: null };

/** True if something already listens on the port at this host. A host this machine lacks (no IPv6) counts as free. */
export function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(false)));
  });
}

/**
 * Display n is in use: an X server's lock names a live process, or there is its socket without a lock. A lock whose
 * process is gone (an Xvfb killed with SIGKILL, a crash, a test run stopped midway) is free: the next Xvfb on n takes
 * over both it and the socket it left, as X servers do (2026-11-22: 44 such locks had taken every display in the
 * ranges, so no sandbox could start). A lock that can't be read, or doesn't hold a pid, still counts as taken.
 */
export function displayTaken(n: number, root = '/tmp'): boolean {
  const lock = `${root}/.X${n}-lock`;
  if (existsSync(lock)) {
    const pid = lockOwner(lock);
    return pid === null || alive(pid);
  }
  return existsSync(`${root}/.X11-unix/X${n}`);
}

/** The pid an X server's lock names, or null when it can't be read or holds none. */
export function lockOwner(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
  } catch {
    return null;
  }
}

/**
 * Display n is up, and it is our X server's: its socket is there and its lock names `xserver` (or a process it
 * started). A socket alone is not enough: a dead server's socket stays until the next one takes the display over, and
 * a sandbox starting at the same moment may have won it. A lock that can't be read is taken as ours.
 */
export function displayIsOurs(n: number, xserver: number | undefined, root = '/tmp'): boolean {
  if (!existsSync(`${root}/.X11-unix/X${n}`)) return false;
  const owner = lockOwner(`${root}/.X${n}-lock`);
  return owner === null || owner === xserver || (xserver !== undefined && parentOf(owner) === xserver);
}

/** Where a sandbox's display comes from when the caller names no range, in order. */
export const DISPLAY_RANGES: readonly { from: number; to: number }[] = [
  { from: 80, to: 89 },
  { from: 100, to: 159 },
];

/** A display on this process's backend (displayBackend()): on an X backend the first free number, on a Wayland one its own. */
export async function pickFreeDisplay(range?: { from: number; to: number }, skip: number[] = [], backend: DisplayBackend = displayBackend()): Promise<FreeDisplay> {
  if (isWaylandBackend(backend)) return { backend, display: null };
  return pickFreeXDisplay(range, skip, backend);
}

/** The first free X display (the pool the X backends share). */
export async function pickFreeXDisplay(range?: { from: number; to: number }, skip: number[] = [], backend: XBackend = 'x11'): Promise<XDisplay> {
  const ranges = range ? [range] : DISPLAY_RANGES;
  for (const r of ranges)
    for (let n = r.from; n <= r.to; n++) {
      if (skip.includes(n) || displayTaken(n)) continue;
      // Free by every sign, but so it is for anyone else looking at this moment: claim it, or go on.
      if (!claimDisplay(n)) continue;
      return { backend, display: n };
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
