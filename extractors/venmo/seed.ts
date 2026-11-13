/**
 * Seed a venmo account's state.json from dither-finance's raw tree (docs/venmo.md), so its first pull is incremental
 * (last month to today), as venmo.py's would be, instead of a backfill. It reads data/raw/venmo's file names and
 * hashes, the newest file per range winning as in venmo.py `_existing`, and merges them with what the account already
 * knows (a range's newer file wins, by its stamp). It also picks one closed range to fetch again on the first pull
 * that finds Venmo signed in, to compare the bytes with dither-finance's file. Prints counts only.
 *
 *   bun extractors/venmo/seed.ts --from $FINANCE_HOME/data/raw --account-dir <dir>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeWhole } from '@dither-accounts/statements-common';
import { activity, iso, rangesFromRaw, stampOf, type VenmoState } from './src/venmo.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
const acct = arg('--account-dir');
if (!from || !acct) {
  console.error('usage: seed.ts --from <dither-finance data/raw> --account-dir <account dir>');
  process.exit(2);
}
const rawDir = join(resolve(from), 'venmo');
const file = join(resolve(acct), 'state.json');
const st: VenmoState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ranges: {} };
st.ranges ??= {};
const seen = rangesFromRaw(rawDir);
let added = 0;
let newer = 0;
for (const [k, v] of Object.entries(seen)) {
  const have = st.ranges[k];
  if (!have) added++;
  else if (stampOf(v.file) > stampOf(have.file)) newer++;
  else continue;
  st.ranges[k] = v;
}
if (Object.keys(st.ranges).length) st.backfilled = true;
// The check: the closed range that ends last (before the first of last month: no new rows can land in it).
const t = new Date();
const firstOfLast = iso(new Date(t.getFullYear(), t.getMonth() - 1, 1));
const closed = Object.entries(seen)
  .filter(([k]) => k.split('_')[1] < firstOfLast)
  .sort(([a], [b]) => (a.split('_')[1] < b.split('_')[1] ? -1 : 1));
if (!st.checked && closed.length) {
  const [range, v] = closed.at(-1)!;
  const bytes = readFileSync(join(rawDir, v.file));
  st.check = { range, sha256: v.sha256, file: v.file, rows: activity(bytes.toString('utf8')), size: bytes.length };
}
writeWhole(file, JSON.stringify(st, null, 1));
console.log(`ranges: ${Object.keys(seen).length} in the raw tree, ${added} added, ${newer} newer; ${Object.keys(st.ranges).length} known; check pending: ${!!st.check}`);
