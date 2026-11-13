/**
 * What dither-finance's connectors/venmo.py decided and wrote, as pure functions (docs/venmo.md): which statement
 * ranges a pull asks for, when a backfill stops, when a file is unchanged, and the file's name and bytes. The
 * extractor (main.ts) makes the requests from Venmo's own /statement page; everything here is testable without it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from '@dither-accounts/statements-common';
import { pyStrip } from '@dither-accounts/statements-common/pystr';

export interface Range {
  start: string;
  end: string;
  backfill: boolean;
}
/** state.json: what the pullers learned from re-reading data/raw/venmo, kept here instead. */
export interface VenmoState {
  /** "<start>_<end>" → the newest file saved for that range (its sha256 and name). */
  ranges: Record<string, { sha256: string; file: string }>;
  backfilled?: boolean;
  /** Seeded: one closed range to fetch again on the first signed-in pull, to compare with dither-finance's bytes. */
  check?: { range: string; sha256: string; file: string; rows: number; size: number } | null;
  /** How that comparison went (no amounts: the hashes' first 16 characters, sizes and row counts). */
  checked?: { range: string; at: number; same: boolean; oldSha16: string; newSha16: string; oldRows: number; newRows: number; oldSize: number; newSize: number } | null;
  /** The last pull that found Venmo signed in. */
  lastSignedInPull?: number | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

/**
 * venmo.py `_ranges`: last month to today; when backfilling (nothing saved yet, or `since`), also this year before
 * last month and then whole past years back to `since` (2009 by default). A January quirk is kept: there, "this year
 * before last month" ends before it starts, as in the Python.
 */
export function ranges(since: number | null | undefined, have: boolean, today: Date): Range[] {
  const t = day(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const lastOfPrev = new Date(t.getFullYear(), t.getMonth(), 0);
  const first = day(lastOfPrev.getFullYear(), lastOfPrev.getMonth() + 1, 1);
  const recent: Range[] = [{ start: iso(first), end: iso(t), backfill: false }];
  if (have && (since === null || since === undefined)) return recent;
  const dayBefore = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1);
  const thisYear: Range[] = first.getMonth() + 1 > 1 ? [{ start: iso(day(t.getFullYear(), 1, 1)), end: iso(dayBefore), backfill: true }] : [];
  const out = [...recent, ...thisYear];
  for (let y = t.getFullYear() - 1; y >= (since || 2009); y--) out.push({ start: `${y}-01-01`, end: `${y}-12-31`, backfill: true });
  return out;
}

/** csv.reader with Python's default dialect, enough for Venmo's statements: quoted fields, doubled quotes, newlines. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // the current row has a field
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
    started = true;
  };
  const endRow = () => {
    if (started || field) endField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (started || field) endRow();
  return rows;
}


/** venmo.py `_activity`: rows with an ID under the header row (the one with "ID" and "Datetime"). */
export function activity(text: string): number {
  const rows = csvRows(text);
  const h = rows.findIndex((r) => r.includes('ID') && r.includes('Datetime'));
  if (h < 0) return 0;
  const col = rows[h].indexOf('ID');
  return rows.slice(h + 1).filter((r) => r.length > col && pyStrip(r[col]) !== '').length;
}

/** %Y%m%dT%H%M%SZ in UTC. */
export function stampUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
export const fileName = (r: { start: string; end: string }, stamp: string) => `venmo_${r.start}_${r.end}_${stamp}.csv`;

/** The download's answer → the file's bytes: `json.loads(body)["jsonData"].encode()`. */
export function statementBytes(status: number, body: string, r: { start: string; end: string }): Uint8Array {
  if (status !== 200) throw new Error(`statement ${r.start}..${r.end}: HTTP ${status}`);
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    throw new Error(`statement ${r.start}..${r.end}: the answer is not JSON`);
  }
  const text = (j as Record<string, unknown> | null)?.jsonData;
  if (typeof text !== 'string') throw new Error(`statement ${r.start}..${r.end}: no jsonData in the answer`);
  return new TextEncoder().encode(text);
}

export interface PullDeps {
  /** GET /api/statement/download-v2 from the page: [status, body]. */
  fetch: (r: Range) => Promise<[number, string]>;
  save: (name: string, bytes: Uint8Array, r: Range) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
}

/** venmo.py `pull`, from the point it has a signed-in page: the ranges, the backfill's stop, unchanged files. */
export async function pullStatements(state: VenmoState, opts: { since?: number | null; full?: boolean }, d: PullDeps): Promise<{ saved: number; requests: number }> {
  const have = state.ranges;
  const haveAny = Object.keys(have).length > 0 && !opts.full;
  let saved = 0;
  let emptyRun = 0;
  let requests = 0;
  for (const r of ranges(opts.since ?? null, haveAny, d.now())) {
    const [status, body] = await d.fetch(r);
    requests++;
    const bytes = statementBytes(status, body, r);
    if (r.backfill) {
      if (!activity(new TextDecoder().decode(bytes))) {
        emptyRun++;
        d.log(`${r.start.slice(0, 4)}: no activity`);
        if (emptyRun >= 2) break;
        continue;
      }
      emptyRun = 0;
    }
    const key = `${r.start}_${r.end}`;
    const sha = sha256hex(bytes);
    if (have[key]?.sha256 === sha) {
      d.log(`${r.start}..${r.end}: unchanged`);
      continue;
    }
    const name = fileName(r, stampUtc(d.now()));
    d.save(name, bytes, r);
    have[key] = { sha256: sha, file: name };
    saved++;
    d.log(`${r.start}..${r.end}: saved`);
    await d.sleep(1500);
  }
  if (opts.full || (opts.since ?? null) !== null || !haveAny) state.backfilled = true;
  return { saved, requests };
}

/** The ranges dither-finance's raw tree has (venmo.py `_existing`: the newest file per range wins, by name). */
export function rangesFromRaw(rawVenmoDir: string): VenmoState['ranges'] {
  const out: VenmoState['ranges'] = {};
  if (!existsSync(rawVenmoDir)) return out;
  for (const f of readdirSync(rawVenmoDir).filter((f) => /^venmo_.*\.csv$/.test(f)).sort()) {
    const parts = f.slice(0, -4).split('_');
    if (parts.length >= 3) out[`${parts[1]}_${parts[2]}`] = { sha256: sha256hex(readFileSync(join(rawVenmoDir, f))), file: f };
  }
  return out;
}

/** A file's stamp (its last _ part), for "which is newer" when two name the same range. */
export const stampOf = (file: string) => file.replace(/\.csv$/, '').split('_').slice(3).join('_');
