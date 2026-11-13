# Monero, view-only (kind `monero`, interfaces `statements` and `monero.view`)

A view-only Monero wallet: from your primary address and private view key it sees what the wallet received and, once
it has key images from the full wallet, what it spent. It pulls its transfers once a day for an app such as
dither-finance ([statements.md](statements.md)). A port of an earlier Python puller (`monero.py`), writing the same
bytes. **It cannot spend**: a view-only
wallet has no spend key, and no op here sends anything. (The Haveno node's own wallet is the separate `haveno`
account, [haveno.md](haveno.md).)

## The account's directory

| | |
|---|---|
| `secret.json` (600) | `{ address, viewKey }`; the restore height and the node are config (`restoreHeight`, `node`) |
| `wallet/` (700) | `view`, `view.keys`, `password` (the wallet file's random password, 600), `rpc.log`, `cli.log`, `ki-imported` (marker) |
| `key_images` (600) | the last key image file given with `monero.keyImages` |
| `spool/`, `pulls.json`, `state.json` | the statements spool, the last pull, the last height and transfer count |

An existing view-only wallet (`view`, `view.keys` and its `password` file) can be **copied** into `wallet/`, so the
account resumes at that wallet's height instead of rescanning for hours. A copy, not a move: the source keeps working
for whatever already uses it, and the two are independent files from then on. `extractors/monero/seed.ts` does the
copy (stop the account first), refusing while any process has a source or target wallet file open, or when the
account already has a wallet:

```
bun extractors/monero/seed.ts --from <wallet dir> --account-dir <account dir>
```

## A pull

Pick the configured node (or the first of three public ones) that answers `get_info` as
synchronized; start `monero-wallet-rpc` (nixpkgs#monero-cli, or config `binDir`) on a random localhost port with a
random digest login, under `setpriv --pdeathsig TERM` so it dies with the extractor; open the wallet (or
`generate_from_keys` the first time) and `refresh` (no op timeout applies: the scan runs inside the extractor, up to
12 h); store and stop. If `key_images` is newer than `ki-imported`, import it with `monero-wallet-cli` (never while
the RPC has the wallet open) and touch the marker. Then open it again for `get_height`, `get_balance` and
`get_transfers` (in, out, pending, pool), and save `monero-<UTC %Y%m%dT%H%M%S>Z.json`:
`{source, pulled_at, wallet (address's first 8), height, key_images, balance, unlocked_balance, transfers[txid, amount,
fee, height, timestamp, confirmations, subaddr_index, unlock_time, double_spend_seen, type]}`, written as
`json.dumps(doc, indent=1)` with the wallet's integers exact.

The RPC client does digest auth by hand over one socket (epee ties the nonce to the connection).
The status is `syncing` while it scans; its layers are keys → node → wallet → key images → pull, and its details
the node, the phase, the wallet's height, the transfer count and the key image state: never the address, the key, a
balance or an amount (the files have those; they go only to an app with the grant).

## Key images

Export them from the full wallet (Feather: Wallet → Advanced → Export key images; CLI: `export_key_images FILE`) and
give the file on the account's own page: its pane has a **Key images** form (`packages/manager/web/src/ui/Monero.tsx`),
which calls `monero.keyImages { base64 }` as the page, behind its login. The op checks the file's magic
("Monero key image export"), stores it as `key_images`, and the next pull imports it. It stays in the `monero.view`
interface (manage) for an app that needs it; an app that only reads statements needs just `statements` read.

## Spends without key images

There is no key short of the spend key that sees spends, and some wallets (Cake Wallet, for one) cannot export key
images. Cake Wallet's history CSV (direction, fee, txid and your note per transaction) fills the gap, but it is data
you export yourself, so it goes to the app that reads it (statements.md: accounts, not data); dither-finance's portal
takes it and matches it to this wallet's transfers by txid.

## Tests

`test/monero.test.ts` with stand-ins for both wallet programs (`extractors/monero/test/fake-bin`: the same flags, digest
auth with epee's two challenges, hand-written JSON with amounts past 2^53) and a fake node. `test/fixtures/monero.json`
is what the Python puller (`monero.py`) wrote against the same stand-ins with its clock fixed (`make-fixtures.ts`); the test
checks the extractor's file is the same bytes but for `pulled_at`, and that its name follows `pulled_at`.
