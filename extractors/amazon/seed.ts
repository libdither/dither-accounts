/**
 * Seed an amazon account's state.json from dither-finance's raw tree (docs/amazon.md), so its first pull is a daily
 * one (this year's pages until nothing is new, then details never read), as amazon.py's would be, instead of a
 * backfill. Reads data/raw/amazon/amazon-*.json in name order (amazon.py `_known` read them in directory order) and
 * learns each order id and whether its details were read; merged with what the account already knows. Prints counts.
 *
 *   bun extractors/amazon/seed.ts --from $FINANCE_HOME/data/raw --account-dir <dir>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { py, writeWhole } from '@dither-accounts/statements-common';
import { type AmazonState, learn } from './src/amazon.ts';

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
const rawDir = join(resolve(from), 'amazon');
const file = join(resolve(acct), 'state.json');
const st: AmazonState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { orders: {} };
st.orders ??= {};
const before = Object.keys(st.orders).length;
const names = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => /^amazon-.*\.json$/.test(f)).sort() : [];
for (const f of names) {
  const doc = py.parse(readFileSync(join(rawDir, f), 'utf8'));
  const orders = py.pyGet(doc, 'orders');
  learn(st, Array.isArray(orders) ? orders : []);
}
if (Object.keys(st.orders).length) st.backfilled = true;
writeWhole(file, JSON.stringify(st));
const all = Object.values(st.orders);
console.log(`${names.length} file(s); orders known: ${all.length} (${all.length - before} new), details read: ${all.filter((o) => o.details).length}, digital: ${Object.keys(st.orders).filter((i) => i.startsWith('D')).length}`);
