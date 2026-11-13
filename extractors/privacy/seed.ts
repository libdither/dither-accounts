/**
 * Seed a privacy account's state.json from dither-finance (docs/privacy.md), once, before the account's first pull:
 * the newest data/raw/privacy-*.json (its name, sha256, counts, and per transaction a hash prefix, so the first pull
 * can say how many transactions are the same, changed, new or gone) and data/privacy_discovery.json's transactions
 * requests (method, path and query names: shapes only). pcom.py pulled the whole history every run and kept no
 * cursor, so neither does this; nothing here changes what a pull asks for. Merges into an existing state.json (a
 * hold, the last pull stay). Stop the account first (the extractor rewrites state.json). Prints counts only.
 *
 *   bun extractors/privacy/seed.ts --from $FINANCE_HOME/data/raw --account-dir <dir>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeWhole } from '@dither-accounts/statements-common';
import { discoveryFrom, type PrivacyState, seedFromRaw } from './src/pcom.ts';

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
const raw = resolve(from);
const file = join(resolve(acct), 'state.json');
const st: PrivacyState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
st.seed = seedFromRaw(raw);
st.checked = null;
const disc = join(raw, '../privacy_discovery.json');
st.discovery = existsSync(disc) ? discoveryFrom(readFileSync(disc, 'utf8')) : null;
writeWhole(file, JSON.stringify(st, null, 1));
console.log(
  `seed: ${st.seed ? `${st.seed.file}, ${st.seed.transactions} transaction(s), ${Object.keys(st.seed.txn).length} distinct` : 'no privacy-*.json found'}; discovery: ${st.discovery ? `${st.discovery.endpoints.length} transactions request(s)` : 'none'}`,
);
