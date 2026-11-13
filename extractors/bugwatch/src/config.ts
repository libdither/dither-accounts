/**
 * bugwatch's config: a JSON file the owner keeps outside the repo, named by the account's `config` field
 * (docs/bugwatch.md has the shape). Read again when it changes, so an edit applies at the next scan.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type SourceKind = 'errors-ndjson' | 'trace-ndjson' | 'text-log';
export const SOURCE_KINDS: SourceKind[] = ['errors-ndjson', 'trace-ndjson', 'text-log'];

export interface Source {
  /** Names the source in fingerprints, notices (`hub: SQLiteError: …`) and the brief. */
  name: string;
  kind: SourceKind;
  /** The file; `*` in a segment matches any name there (accounts/*\/adapter.log). */
  path: string;
  /** The checkout a thread works in (`{project}`), and paths in frames are made relative to it. */
  project?: string;
  /** The branch a thread's worktree starts from (`{base}`). */
  base?: string;
  /** The data directory for trace-summary in the brief; else the directory above the file's `traces/`. */
  data?: string;
}

export interface Threads {
  /** argv, never a shell: {title}, {project} and {base} are filled in; the brief goes to its stdin. */
  command: string[];
  gapMinutes: number;
  dayMax: number;
  /** How many bugs wait for a thread (the most frequent kept). */
  queueMax: number;
}

export interface Config {
  sources: Source[];
  /** Records whose where, name or message match are dropped before anything else. */
  ignore: RegExp[];
  /** `source/where` (errors-ndjson's source, as `attempt/POST /api/groups`) matches: every occurrence is a bug, at most once per gapHours. */
  always: { match: RegExp; gapHours: number }[];
  threads: Threads | null;
  /** Appended to a thread's brief when `match` fits its fingerprint text. */
  briefs: { match: RegExp; file: string }[];
  /** A spike is announced again at most this often (hours). */
  spikeGapHours: number;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v.trim();
};
const optStr = (v: unknown, what: string) => (v === undefined || v === null || v === '' ? undefined : str(v, what));
const num = (v: unknown, d: number, what: string, min = 0) => {
  if (v === undefined || v === null) return d;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`${what} must be a number of at least ${min}`);
  return v;
};
const regex = (v: unknown, what: string) => {
  const s = str(v, what);
  try {
    return new RegExp(s);
  } catch (e) {
    throw new Error(`${what} is not a regular expression: ${(e as Error).message}`);
  }
};
const arr = (v: unknown, what: string): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
  return v;
};

/** A config from its parsed JSON; relative paths are taken from `dir` (the config file's directory). */
export function parseConfig(json: unknown, dir: string): Config {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('the config must be a JSON object');
  const j = json as Record<string, unknown>;
  const path = (v: unknown, what: string) => {
    const s = str(v, what);
    return isAbsolute(s) ? s : resolve(dir, s);
  };
  const names = new Set<string>();
  const sources = arr(j.sources, 'sources').map((x, i): Source => {
    const s = (x ?? {}) as Record<string, unknown>;
    const name = str(s.name, `sources[${i}].name`);
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`sources[${i}].name must be letters, digits, ".", "-" or "_" (at most 40)`);
    if (names.has(name)) throw new Error(`two sources are called "${name}"`);
    names.add(name);
    const kind = s.kind as SourceKind;
    if (!SOURCE_KINDS.includes(kind)) throw new Error(`sources[${i}].kind must be one of ${SOURCE_KINDS.join(', ')}`);
    const project = s.project === undefined ? undefined : path(s.project, `sources[${i}].project`);
    const data = s.data === undefined ? undefined : path(s.data, `sources[${i}].data`);
    return { name, kind, path: path(s.path, `sources[${i}].path`), ...(project ? { project } : {}), ...(optStr(s.base, `sources[${i}].base`) ? { base: optStr(s.base, '')! } : {}), ...(data ? { data } : {}) };
  });
  if (!sources.length) throw new Error('the config has no sources');
  let threads: Threads | null = null;
  if (j.threads !== undefined && j.threads !== null) {
    const t = j.threads as Record<string, unknown>;
    const command = arr(t.command, 'threads.command').map((a, i) => {
      if (typeof a !== 'string') throw new Error(`threads.command[${i}] must be a string`);
      return a;
    });
    if (!command.length || !command[0]) throw new Error('threads.command must name a program');
    threads = { command, gapMinutes: num(t.gapMinutes, 15, 'threads.gapMinutes'), dayMax: num(t.dayMax, 6, 'threads.dayMax'), queueMax: num(t.queueMax, 10, 'threads.queueMax', 1) };
  }
  return {
    sources,
    ignore: arr(j.ignore, 'ignore').map((r, i) => regex(r, `ignore[${i}]`)),
    always: arr(j.always, 'always').map((x, i) => {
      const a = (x ?? {}) as Record<string, unknown>;
      return { match: regex(a.match, `always[${i}].match`), gapHours: num(a.gapHours, 24, `always[${i}].gapHours`) };
    }),
    threads,
    briefs: arr(j.briefs, 'briefs').map((x, i) => {
      const b = (x ?? {}) as Record<string, unknown>;
      return { match: regex(b.match, `briefs[${i}].match`), file: path(b.file, `briefs[${i}].file`) };
    }),
    spikeGapHours: num(j.spikeGapHours, 6, 'spikeGapHours'),
  };
}

export function loadConfig(file: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} does not read as JSON: ${(e as Error).message}`);
  }
  return parseConfig(json, dirname(file));
}

/** Reads the config again only when its file changed. */
export class ConfigFile {
  private mtime = -1;
  private size = -1;
  config: Config | null = null;
  error: string | null = null;

  constructor(readonly path: string) {}

  /** The config now; throws (and keeps the error) when it cannot be read and none was read before. */
  get(): Config {
    try {
      const st = statSync(this.path);
      if (st.mtimeMs !== this.mtime || st.size !== this.size || !this.config) {
        this.config = loadConfig(this.path);
        this.mtime = st.mtimeMs;
        this.size = st.size;
        this.error = null;
      }
    } catch (e) {
      this.error = (e as Error).message;
      if (!this.config) throw e;
    }
    return this.config!;
  }
}
