/**
 * Copy a view-only wallet into a monero account's directory (docs/monero.md), so it resumes at the wallet's height
 * instead of rescanning. A copy, not a move: the source keeps working for whoever has it (dither-finance's puller).
 * Refuses while any process has a source or target wallet file open, or when the target already has a wallet.
 * Prints names and sizes only.
 *
 *   bun extractors/monero/seed.ts --from $FINANCE_HOME/secrets/monero-wallet --account-dir <dir>
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBy } from './src/wallet.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
const acct = arg('--account-dir');
if (!from || !acct) {
  console.error('usage: seed.ts --from <wallet dir> --account-dir <account dir>');
  process.exit(2);
}
const FILES = ['view', 'view.keys', 'password'];
const to = join(resolve(acct), 'wallet');
for (const f of FILES) if (!existsSync(join(from, f))) throw new Error(`${f} is not in the source`);
if (existsSync(join(to, 'view'))) throw new Error('the account already has a wallet; not overwriting it');
for (const f of FILES) {
  for (const p of [join(resolve(from), f), join(to, f)]) {
    const pids = openBy(p);
    if (pids.length) throw new Error(`${p} is open in process(es) ${pids.join(', ')}; wait for it to finish`);
  }
}
mkdirSync(to, { recursive: true, mode: 0o700 });
chmodSync(to, 0o700);
for (const f of FILES) {
  copyFileSync(join(from, f), join(to, f));
  chmodSync(join(to, f), 0o600);
  console.log(`${f}: ${statSync(join(to, f)).size} bytes`);
}
