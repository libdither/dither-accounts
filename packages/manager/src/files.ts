/**
 * What the manager reads of an account's directory: the tail of its extractor's log, and the names and sizes of its
 * files (never what is in them). And the one thing it deletes there: a directory it made itself, when an app or the
 * page asks to purge an account. A directory imported in place belongs to where it came from and is never deleted.
 */
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DirEntry, DirListing } from './api-types.ts';

export const LOG = 'adapter.log';

/** The last `bytes` of a file, as lines (the first, cut, dropped). */
export function tail(path: string, lines: number, bytes = 512 * 1024): { lines: string[]; size: number } {
  if (!existsSync(path)) return { lines: [], size: 0 };
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const all = buf.toString('utf8').split('\n');
    if (start > 0) all.shift();
    if (all.at(-1) === '') all.pop();
    return { lines: all.slice(-lines), size };
  } finally {
    closeSync(fd);
  }
}

/** An account's log, the last `lines` (10 to 5000, default 400). */
export function logTail(dir: string, lines?: unknown): { lines: string[]; size: number } {
  const n = Math.min(5000, Math.max(10, Number(lines) || 400));
  return tail(join(dir, LOG), n);
}

/** A directory's entries with their sizes, counting at most `budget` files or `ms` milliseconds. */
export function listDir(path: string, budget = 200_000, ms = 3000): DirListing {
  if (!existsSync(path)) return { path, exists: false, entries: [], size: 0, partial: false };
  const end = Date.now() + ms;
  let left = budget;
  let partial = false;
  const walk = (dir: string): { size: number; files: number } => {
    let size = 0;
    let files = 0;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return { size, files };
    }
    for (const n of names) {
      if (--left < 0 || Date.now() > end) {
        partial = true;
        break;
      }
      try {
        const st = lstatSync(join(dir, n));
        if (st.isDirectory()) {
          const sub = walk(join(dir, n));
          size += sub.size;
          files += sub.files;
        } else {
          size += st.size;
          files++;
        }
      } catch {}
    }
    return { size, files };
  };
  const entries: DirEntry[] = [];
  for (const n of readdirSync(path).sort()) {
    try {
      const st = lstatSync(join(path, n));
      if (st.isDirectory()) {
        const sub = walk(join(path, n));
        entries.push({ name: n, type: 'dir', size: sub.size, files: sub.files, mtime: st.mtimeMs });
      } else entries.push({ name: n, type: st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other', size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return { path, exists: true, entries, size: entries.reduce((a, e) => a + e.size, 0), partial };
}

/** Whether the manager made this account's directory (`<data>/accounts/<id>`), so it may delete it. */
export function ownDir(dataDir: string, id: string, dir: string): boolean {
  return resolve(dir) === resolve(dataDir, 'accounts', id);
}

/** Delete an account's directory if the manager made it; else say why it stays. */
export function purgeDir(dataDir: string, id: string, dir: string): { purged: boolean; why?: string } {
  if (!ownDir(dataDir, id, dir)) return { purged: false, why: 'imported in place: the directory belongs to where it came from' };
  rmSync(dir, { recursive: true, force: true });
  return { purged: true };
}
