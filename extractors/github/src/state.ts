/**
 * Where the extractor is in your notifications, kept in the account directory's state.json so a restart picks up
 * where it was instead of announcing every unread thread again: GitHub's Last-Modified for the unread list, the newest
 * update seen, and per thread its id, when it last changed and whether it was unread. Ids and times only, never what a
 * notification says. Written whole (a temporary file renamed over the old one).
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface State {
  version: 1;
  /** When the first full look was taken (null: not yet; what is unread then is not announced). */
  baselineAt: number | null;
  /** The unread list's Last-Modified, sent back as If-Modified-Since. */
  lastModified: string | null;
  /** The newest updated_at seen (ms): a poll reads pages only as far back as this. */
  newest: number;
  /** When the whole unread list was last read (which is when reads elsewhere are noticed). */
  lastReconcileAt: number;
  /** thread id → [updated_at ms, 1 unread | 0 read]. */
  seen: Record<string, [number, 0 | 1]>;
}

export const fresh = (): State => ({ version: 1, baselineAt: null, lastModified: null, newest: 0, lastReconcileAt: 0, seen: {} });

export function loadState(path: string, log?: (m: string) => void): State {
  if (!existsSync(path)) return fresh();
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as State;
    if (s?.version !== 1 || typeof s.seen !== 'object' || s.seen === null) throw new Error('not a version 1 state');
    return { ...fresh(), ...s };
  } catch (e) {
    log?.(`${path} does not read (${(e as Error).message}); starting over, without announcing what is unread now`);
    return fresh();
  }
}

export function saveState(path: string, s: State) {
  const tmp = join(dirname(path), `.state.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(s));
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

export interface Seen {
  id: string;
  updatedAt: number;
}

/**
 * A poll's unread threads against what was seen: `news` are threads new to us, unread again after being read, or
 * changed since (a new comment); `reads` are threads that were unread and are no longer in the list, which only a
 * complete list can say. Updates `s` in place.
 */
export function applyUnread(s: State, unread: Seen[], complete: boolean): { news: string[]; reads: string[] } {
  const news: string[] = [];
  const reads: string[] = [];
  const present = new Set<string>();
  for (const t of unread) {
    present.add(t.id);
    const was = s.seen[t.id];
    if (!was || was[1] === 0 || t.updatedAt > was[0]) news.push(t.id);
    s.seen[t.id] = [Math.max(t.updatedAt, was?.[0] ?? 0), 1];
    if (t.updatedAt > s.newest) s.newest = t.updatedAt;
  }
  if (complete) {
    for (const [id, [at, u]] of Object.entries(s.seen)) {
      if (u === 1 && !present.has(id)) {
        reads.push(id);
        s.seen[id] = [at, 0];
      }
    }
  }
  return { news, reads };
}

/** Threads read through this account (markRead, markAllRead): the ones that were unread. */
export function markRead(s: State, ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const was = s.seen[id];
    if (was?.[1] === 1) out.push(id);
    s.seen[id] = [was?.[0] ?? 0, 0];
  }
  return out;
}

export const unreadIds = (s: State, before?: number) =>
  Object.entries(s.seen)
    .filter(([, [at, u]]) => u === 1 && (before === undefined || at <= before))
    .map(([id]) => id);

/** Forget read threads older than `keepMs`, and the oldest read ones past `max` entries. Unread ones always stay. */
export function prune(s: State, now = Date.now(), keepMs = 30 * 86_400_000, max = 5000) {
  const read = Object.entries(s.seen).filter(([, [, u]]) => u === 0);
  for (const [id, [at]] of read) if (at < now - keepMs) delete s.seen[id];
  const left = Object.entries(s.seen);
  if (left.length > max) {
    const old = left
      .filter(([, [, u]]) => u === 0)
      .sort((a, b) => a[1][0] - b[1][0])
      .slice(0, left.length - max);
    for (const [id] of old) delete s.seen[id];
  }
}
