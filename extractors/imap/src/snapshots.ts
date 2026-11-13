/**
 * What mail.changes compares against on servers without QRESYNC: per mailbox, the UIDs it had (CONDSTORE finds the
 * flag changes itself) or the UIDs with their flags (neither), as of a state it gave out. They live in the account
 * directory's sync/, so states survive a restart; a mailbox keeps its newest KEEP, and an older state answers 410.
 * Equal snapshots are one file, so polling an unchanged mailbox gives the same state back.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromRanges, toRanges } from './ids.ts';

export interface Snapshot {
  /** Sorted. */
  uids: number[];
  /** UID → its flags and labels as one string (f mode only). */
  flags: Map<number, string> | null;
}

const KEEP = 32;
const hash = (s: string, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n);

export class Snapshots {
  constructor(private dir: string) {}

  private boxDir(path: string, uidValidity: string) {
    return join(this.dir, 'sync', hash(`${path}\0${uidValidity}`));
  }

  save(path: string, uidValidity: string, snap: Snapshot): string {
    let body: Record<string, unknown>;
    if (snap.flags) {
      const groups = new Map<string, number[]>();
      for (const u of snap.uids) {
        const k = snap.flags.get(u) ?? '';
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
      }
      body = { g: Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, us]) => [k, toRanges(us)])) };
    } else body = { u: toRanges(snap.uids) };
    const text = JSON.stringify({ v: 1, path, uidValidity, ...body });
    const id = hash(text);
    const d = this.boxDir(path, uidValidity);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const f = join(d, `${id}.json`);
    if (existsSync(f)) {
      const now = new Date();
      utimesSync(f, now, now);
    } else {
      writeFileSync(`${f}.tmp`, text, { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    }
    this.prune(d);
    return id;
  }

  load(path: string, uidValidity: string, id: string): Snapshot | null {
    const f = join(this.boxDir(path, uidValidity), `${id}.json`);
    if (!/^[0-9a-f]{16}$/.test(id) || !existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j.path !== path || j.uidValidity !== uidValidity) return null;
      if (j.u !== undefined) return { uids: fromRanges(j.u), flags: null };
      const flags = new Map<number, string>();
      for (const [k, r] of Object.entries(j.g as Record<string, string>)) for (const u of fromRanges(r)) flags.set(u, k);
      return { uids: [...flags.keys()].sort((a, b) => a - b), flags };
    } catch {
      return null;
    }
  }

  private prune(d: string) {
    const files = readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: statSync(join(d, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP)) rmSync(join(d, x.f), { force: true });
  }
}
