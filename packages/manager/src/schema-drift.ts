/**
 * Schema drift: what a network sends that the extractor does not map yet (docs/manager.md, "Schema drift"). An
 * extractor names each place it reads a payload (a surface: "matrix.event.content", "zulip.event") and the keys or
 * tags it knows there; anything else is counted by name, logged once when first seen, and summed up in the account's
 * status details. A new field, event type, constructor or enum value then shows up in the log the day a client
 * update starts sending it, instead of being dropped without a word.
 *
 * Privacy: only names are kept, never values. A watch stores (surface, name, kind, count, firstSeen, lastSeen) and
 * nothing else: no field value, no text, no id, no URL, no payload. A name that looks like a value (an id, a digit
 * run, a user or room id, anything outside a short identifier's alphabet) is counted under `VALUE_LIKE` instead of by
 * name, so a map keyed by ids that slips into checkKeys cannot leak them either.
 *
 * Bounded: at most `max` distinct (surface, name, kind) entries (500); sightings past that are only counted
 * (`overflow`). Cheap on the hot path: checkKeys is one `for...in` over the object against a Set, and a known key or
 * tag costs one Set lookup.
 */

export type DriftKind = 'unknown_key' | 'unknown_tag';

export interface DriftEntry {
  /** Where it was seen, as the extractor names it: "matrix.event.content". */
  surface: string;
  /** The key or tag's name, or VALUE_LIKE. */
  name: string;
  kind: DriftKind;
  count: number;
  /** ms since the epoch. */
  firstSeen: number;
  lastSeen: number;
}

export interface DriftSummary {
  /** Most seen first. */
  unknown: DriftEntry[];
  /** Sightings of new names after the watch was full. */
  overflow: number;
}

export type DriftLog = (level: 'info', msg: string) => void;

export interface SchemaWatchOpts {
  /** Distinct entries kept at most (500). */
  max?: number;
  /** Told once per new entry: `schema drift: unknown key "foo" on "matrix.event.content"`. */
  log?: DriftLog;
  now?: () => number;
}

/** The name an entry gets when its key or tag looks like a value rather than a schema name. */
export const VALUE_LIKE = '(value-like)';

/**
 * A schema name: starts with a letter or `_`, then letters, digits and `_ . - / :`, at most 64 long, and no run of 5
 * or more digits (ids, phone numbers, timestamps); or an enum's number of at most 4 digits (a Discord message type).
 * Matrix ids (`@u:hs`, `!r:hs`, `$e`), URLs (`//`) and anything with spaces, `@`, `+`, `=` or markup fail it.
 */
const NAME = /^[A-Za-z_][\w.\-/:]{0,63}$/;
const DIGITS = /\d{5,}/;
const ENUM_NUMBER = /^\d{1,4}$/;
const EMPTY: ReadonlySet<string> = new Set();

export function schemaName(name: string): string {
  return (NAME.test(name) && !DIGITS.test(name) && !name.includes('//')) || ENUM_NUMBER.test(name) ? name : VALUE_LIKE;
}

export class SchemaWatch {
  private readonly entries = new Map<string, DriftEntry>();
  private readonly max: number;
  private readonly now: () => number;
  private log: DriftLog | undefined;
  private overflowCount = 0;

  constructor(opts: SchemaWatchOpts = {}) {
    this.max = opts.max ?? 500;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
  }

  /** Set (or replace) the logger, for extractors whose log is ready only after the watch is made. */
  setLog(log: DriftLog | undefined) {
    this.log = log;
  }

  /**
   * Count each key of `obj` that is not in `known` and whose value is neither null nor undefined (an optional field
   * left out by a serializer is not drift). Returns how many unknown keys this object had. Not an object: nothing.
   */
  checkKeys(surface: string, obj: unknown, known: ReadonlySet<string>): number {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
    let n = 0;
    const o = obj as Record<string, unknown>;
    for (const k in o) {
      if (known.has(k)) continue;
      if (o[k] === null || o[k] === undefined) continue;
      this.record(surface, k, 'unknown_key');
      n++;
    }
    return n;
  }

  /**
   * Count `tag` (an event type, constructor, enum value, "type/op" pair) when it is not in `known`. Returns true when
   * it was unknown. A tag that is not a string (missing, a number from a newer enum) counts under its typeof.
   */
  checkTag(surface: string, tag: unknown, known: ReadonlySet<string>): boolean {
    if (typeof tag === 'string') {
      if (known.has(tag)) return false;
      this.record(surface, tag, 'unknown_tag');
      return true;
    }
    if (typeof tag === 'number' && known.has(String(tag))) return false;
    if (typeof tag === 'number' && Number.isInteger(tag) && tag >= 0 && tag < 10_000) this.record(surface, String(tag), 'unknown_tag');
    // Not a name at all: counted under its type (made here, so not checked as a name).
    else this.record(surface, `(${typeof tag})`, 'unknown_tag', true);
    return true;
  }

  /**
   * Count `tag` as unknown without a set to check it against: for the `default:` of a switch whose cases are the
   * known tags, so the list is not written twice.
   */
  unknownTag(surface: string, tag: unknown) {
    this.checkTag(surface, tag, EMPTY);
  }

  /** Every entry, most seen first, and the sightings past the cap. Names and counts only. */
  summary(): DriftSummary {
    return { unknown: [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen), overflow: this.overflowCount };
  }

  /** How many distinct unknown names were seen. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * For an account's status details: `schemaDrift` (distinct names), and `schemaDriftTop`, the most seen ones as
   * `surface key:name ×count`, joined. Empty when nothing has drifted, so a status without drift has neither.
   */
  details(top = 6): Record<string, string | number> {
    if (!this.entries.size && !this.overflowCount) return {};
    const s = this.summary();
    const d: Record<string, string | number> = {
      schemaDrift: s.unknown.length,
      schemaDriftTop: s.unknown
        .slice(0, top)
        .map((e) => `${e.surface} ${e.kind === 'unknown_key' ? 'key' : 'tag'}:${e.name} ×${e.count}`)
        .join(', '),
    };
    if (s.overflow) d.schemaDriftOverflow = s.overflow;
    return d;
  }

  /** Forget everything seen (tests; a fresh session). */
  clear() {
    this.entries.clear();
    this.overflowCount = 0;
  }

  private record(surface: string, rawName: string, kind: DriftKind, ours = false) {
    const name = ours ? rawName : schemaName(rawName);
    const sfc = schemaName(surface);
    const id = `${kind}\u0000${sfc}\u0000${name}`;
    const at = this.now();
    const e = this.entries.get(id);
    if (e) {
      e.count++;
      e.lastSeen = at;
      return;
    }
    if (this.entries.size >= this.max) {
      this.overflowCount++;
      return;
    }
    this.entries.set(id, { surface: sfc, name, kind, count: 1, firstSeen: at, lastSeen: at });
    this.log?.('info', `schema drift: unknown ${kind === 'unknown_key' ? 'key' : 'tag'} "${name}" on "${sfc}"`);
  }
}

/** A Set from a list, typed read-only: `const KNOWN = known('body', 'msgtype')`. */
export function known(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}
