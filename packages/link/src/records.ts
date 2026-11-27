/**
 * Reading a list of records out of an outside service's answer, so that one record that is off costs that record, not
 * the whole answer (docs/records.md).
 *
 *   const skips = new Skips({ log: link.log });
 *   const r = readEach(list, (raw, i) => readPerson(raw, `json[0][${i}]`), { what: 'gmail.contacts', skips, idOf });
 *   // r.items: what was read; r.skipped: what was left out, by id when it had one, where, and what was expected
 *
 * Two kinds of check, as in Gmail's sync parser (extractors/google/src/gmail/protocol.ts, its Tally):
 *
 * - The answer's own envelope (the list is a list, the cursor is where it goes): the reader throws as before, and the
 *   whole answer is refused. Nothing here changes that.
 * - One record's fields: the reader throws a RecordError for that record. readEach leaves it out, names it in
 *   `skipped`, and counts it in `skips` by what and why (never a value). One log line per kind of skip, not per record.
 *
 * Unless most of the answer fails so (looksChanged: at least SYSTEMIC records left out, and more than were read). Then
 * the layout changed rather than one record being odd, and records that passed may have passed by accident: the
 * whole answer is refused with a LayoutChanged (502, kind 'bug'), as an answer with a bad envelope is.
 *
 * A record left out is not known to be absent: a caller that works out what was removed from what an answer lacks
 * must never count a skipped id as removed, and must not work out removals at all from an answer with a skip that has
 * no id (`complete` false and `anonymous` true). It may keep what it last knew of a skipped id, or forget it so the
 * next read asks again; it never deletes the user's data for it.
 *
 * Only RecordError is caught: any other error from a reader (a TypeError from our own code) is a bug and goes up.
 */
import { StatusError } from './index.ts';

/** One record not laid out as the reader knows it: where (a path, never a value), what was expected there, and what kind of thing was there instead. */
export class RecordError extends Error {
  constructor(
    readonly where: string,
    readonly expected: string,
    readonly got: string,
  ) {
    super(`at ${where}: expected ${expected}, got ${got}`);
  }
}

/** A whole answer whose records mostly failed: the layout changed. 502, kind 'bug'. */
export class LayoutChanged extends StatusError {
  constructor(
    readonly what: string,
    readonly first: RecordError,
    readonly failed: number,
    readonly of: number,
  ) {
    super(`${what}: the answer is not laid out as this extractor knows it (${first.message}, and ${failed} of ${of} records failed); nothing was returned rather than possibly misread records`, 502, undefined, { kind: 'bug' });
  }
}

/** A record left out: its id when the reader could tell it, where it was, and what was expected there. Never a value. */
export interface Skipped {
  id: string | null;
  where: string;
  expected: string;
  got: string;
}

/** At least this many records left out of one answer, and more of them than were read, is a changed layout. */
export const SYSTEMIC = 3;
/**
 * Whether an answer's records failed as a changed layout would make them: at least SYSTEMIC failed, and more than were
 * read. One or two odd records cannot tell a drift from a bad record, and refusing the answer for them refuses it for
 * every record until that one leaves (Gmail's sync answered 502 for days so, for one message: #53); they are counted
 * and logged instead, and a drift that hits them all shows on the next answer of any size.
 */
export const looksChanged = (read: number, skipped: number): boolean => skipped >= SYSTEMIC && skipped > read;

export interface ReadResult<T> {
  items: T[];
  skipped: Skipped[];
  /** No record was left out: the answer is whole. */
  complete: boolean;
  /** A record was left out that has no id: nothing may be worked out from what this answer lacks. */
  anonymous: boolean;
}

/**
 * Each record of `list` through `read`: a value is kept, `undefined` is left out on purpose (not a skip: a group where
 * people are wanted), a RecordError is a skip. Throws LayoutChanged when looksChanged; counts the skips in `o.skips`
 * when it does not. `o.idOf` names a record from its raw form (its id field, read loosely), for `skipped`.
 */
export function readEach<T>(
  list: readonly unknown[],
  read: (raw: unknown, i: number) => T | undefined,
  o: { what: string; skips?: Skips | null; idOf?: (raw: unknown) => string | null },
): ReadResult<T> {
  const items: T[] = [];
  const skipped: Skipped[] = [];
  let first: RecordError | null = null;
  let kept = 0;
  list.forEach((raw, i) => {
    try {
      const v = read(raw, i);
      kept++;
      if (v !== undefined) items.push(v);
    } catch (e) {
      if (!(e instanceof RecordError)) throw e;
      first ??= e;
      let id: string | null = null;
      try {
        id = o.idOf?.(raw) ?? null;
      } catch {}
      skipped.push({ id, where: e.where, expected: e.expected, got: e.got });
    }
  });
  if (first && looksChanged(kept, skipped.length)) throw new LayoutChanged(o.what, first, skipped.length, list.length);
  for (const k of skipped) o.skips?.note(o.what, k);
  return { items, skipped, complete: skipped.length === 0, anonymous: skipped.some((k) => k.id === null) };
}

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

/**
 * An extractor's count of records left out, by what and what was expected (`gmail.contacts: an address`), since it
 * started. It logs a kind the first time it is seen, then at most once per `quietMs` (an hour) while it keeps coming,
 * with its count: one line per kind, so a drift is in the log (and bugwatch reads it) without a line per record.
 * `summary()` goes in the account's status details, so the page and the self-check show it.
 */
export class Skips {
  readonly counts = new Map<string, number>();
  private logged = new Map<string, { at: number; n: number }>();
  constructor(private o: { log?: Log; now?: () => number; quietMs?: number } = {}) {}

  note(what: string, k: Pick<Skipped, 'where' | 'expected' | 'got'>) {
    const key = `${what}: ${k.expected}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const now = this.o.now ? this.o.now() : Date.now();
    const last = this.logged.get(key);
    if (last && now - last.at < (this.o.quietMs ?? 3_600_000)) return;
    this.logged.set(key, { at: now, n });
    this.o.log?.('warn', `records left out: ${what}, expected ${k.expected}, got ${k.got} (at ${k.where}); ${n} so far${last ? `, ${n - last.n} since the last line` : ''}`);
  }

  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  /** "gmail.contacts: an address 3, …": kinds and counts, most first; null when none. */
  summary(max = 6): string | null {
    if (!this.counts.size) return null;
    return [...this.counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  }
}
