/**
 * The startup backfill's memory across restarts (main.ts startupBackfill): after each start the extractor fetches the
 * latest messages of DMs and channels with unread mentions; what it fetched is kept in the account's directory, so the
 * next start skips a channel whose newest message is still the one fetched then. Entries expire after a few days, so
 * a channel is looked at again now and then anyway.
 *
 *   <account dir>/backfill.json (0600): { "<channel id>": { "last": "<newest message id fetched>" | null, "at": <ms> } }
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const BACKFILL_FILE = 'backfill.json';
export const BACKFILL_TTL_MS = 3 * 86_400_000;

export interface BackfillEntry {
  last: string | null;
  at: number;
}

const SNOWFLAKE = /^\d{1,25}$/;

/** The newer of two snowflakes (either may be absent). */
function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

export class BackfillMemory {
  private done = new Map<string, BackfillEntry>();

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [id, e] of Object.entries(raw ?? {})) {
        const v = e as Partial<BackfillEntry> | null;
        if (!SNOWFLAKE.test(id) || !v || typeof v.at !== 'number') continue;
        if (v.last !== null && (typeof v.last !== 'string' || !SNOWFLAKE.test(v.last))) continue;
        this.done.set(id, { last: v.last, at: v.at });
      }
    } catch {}
    this.expire();
  }

  /** Whether a channel need not be fetched: fetched lately, and its newest message (from the snapshot) is the one fetched then. */
  fresh(channelId: string, newest: string | null | undefined): boolean {
    const e = this.done.get(channelId);
    if (!e || this.now() - e.at > BACKFILL_TTL_MS) return false;
    return (newest ?? null) === e.last;
  }

  /** A channel was fetched: the newest of what came back (or, with nothing, the snapshot's newest) is remembered. */
  record(channelId: string, fetchedIds: string[], newest: string | null | undefined) {
    let last: string | null = null;
    for (const id of fetchedIds) if (SNOWFLAKE.test(id)) last = newer(last, id);
    this.done.set(channelId, { last: last ?? (newest && SNOWFLAKE.test(newest) ? newest : null), at: this.now() });
    this.save();
  }

  entries(): Record<string, BackfillEntry> {
    return Object.fromEntries(this.done);
  }

  private expire() {
    const now = this.now();
    for (const [id, e] of this.done) if (now - e.at > BACKFILL_TTL_MS) this.done.delete(id);
  }

  private save() {
    this.expire();
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.done)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
}
