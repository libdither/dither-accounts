# The `statements` interface: financial accounts as files

The finance kinds hand an app (such as [dither-finance](https://github.com/libdither/dither-finance)) what they
pulled as **files**: each site's own responses or exports, under the names dither-finance's parsers expect in its
`data/raw/`. Files through a grant, not parsed rows: the app keeps them as they came and parses them itself. Kinds
with it: `simplefin` ([simplefin.md](simplefin.md)), `monero` ([monero.md](monero.md)), and the extension-only browser
kinds `venmo` ([venmo.md](venmo.md)), `amazon` ([amazon.md](amazon.md)) and `schwab` ([schwab.md](schwab.md)), and
`privacy` ([privacy.md](privacy.md)), which, like `schwab`, signs itself in with its own passkey
([passkeys.md](passkeys.md)). `schwab` hands over Schwab's own CSV exports (schwab.com offers no PDF of those pages).

**Accounts, not data.** A kind pulls what its live account says, and keeps what keeping that account needs (sign-ins,
sessions, passkeys, key images). Data you hand over yourself is the app's: a file you export from some other app
(Cake Wallet's history CSV, for example) is uploaded to the app that reads it (dither-finance's portal), not given
to an account here. The manager keeps account state and APIs, not data.

**Nothing moves money.** Every op is `read`; no level of `statements` pays, transfers, changes a card or orders. The
one kind-specific write is `monero.keyImages` in the `monero.view` interface (manage: it changes what the view-only
wallet knows; it still cannot spend), given on the Monero account's own page; no app has it.

## Ops and events

`packages/interfaces/src/statements.ts`. Times are milliseconds since the epoch.

| op | input → output |
|---|---|
| `statements.list` | `{ after?, limit? }` → `{ files: StatementFile[], next }`: files with `seq > after`, oldest first, at most `limit` (default 100, max 1000); `next` is the last seq given (or `after`) |
| `statements.fetch` | `{ id }` → `{ name, dir, mime, size, sha256, base64 }`; files up to 40 MB (one WebSocket frame is 64 MB) |
| `statements.refresh` | `{ full?, since?, details?, days? }` → `{ started, reason? }`: a pull now; it reports through `statements.pulled` and the status. One pull at a time |
| `statements.ack` | `{ through }` → `{ acked }`: the app has every file up to that seq |
| `statements.accounts` | `{}` → `{ accounts: { id, name, institution, currency, kind }[] }`: names only, **never balances** (Try it on the page would show them to anyone signed in) |

`StatementFile` is `{ seq, id, name, dir, mime, size, sha256 (hex), pulledAt, coverage?: { from, to } }`: `name` and
`dir` are what the app saves it as (`simplefin-20260101T000000-w0.json` in `""`, `venmo_…csv` in `venmo`).

Events: `statements.file { file }` when a file is whole in the spool, `statements.pulled { ok, saved, skipped?, needs? }`
when a pull ends (`needs` says what it needs from you, or why it failed), and the account's `hello` and `status`.

## The shared code (`extractors/statements-common`)

- **Spool** (`spool.ts`): `<account>/spool/` (700); each file as `<seq>-<sha16>` (600), written whole (tmp, fsync,
  rename) before its entry goes into `index.json` (also written whole). `seq` only grows, across restarts and sweeps.
  An ack marks files; acked files stay **30 days** more (a lost write on the app's side can fetch again), then go.
  Unacked files never go by themselves. A stray file (a crash between the file and the index) is removed at start.
- **Runner** (`runner.ts`): the ops above, one pull at a time, and the **daily pull**: config `pullAt` ("HH:MM" local,
  default 05:30) plus a jitter of up to `jitterMinutes` (default 20) fixed per account and day. Like a systemd timer
  with `Persistent=true`, a start that finds the last pull older than the last slot pulls at once; an account that has
  never pulled waits for its slot or a `statements.refresh`. A failed daily pull is tried hourly, three times.
  `schedule: false` turns the daily pull off. `pulls.json` keeps how the last pull went; the status's `details` show
  it (`lastPullAt`, `lastPullOk`, `lastPullSaved`, `nextPullAt`, `spoolSeq`, `spoolAcked`, `spoolWaiting`) and its last
  layer is `pull`. A pull that throws `NeedsYou` (a revoked access URL) becomes the status's `attention`.
- **The browser kinds' half** (`tabs.ts`, `extension/driver.js`): a packages/browser sandbox and a tab driver over
  its extension (open, load to DOMContentLoaded, run one of the kind's page functions with `chrome.scripting`, in the
  top frame or, `execAll`, in every frame it may reach, bring forward, close), with no DevTools and no automation;
  `pystr.ts` has Python's `str.strip` and `splitlines`. A kind may start a pull itself (`refresh(opts, 'sign-in')`:
  Venmo and Schwab, right after you sign in).
- **Python's JSON** (`pyjson.ts`): the files are what `json.load` then `json.dumps(…, indent=N)` writes, as the
  Python pullers these kinds were ported from wrote them. JavaScript's JSON
  differs from that in numbers (Python keeps integers exact at any size, as Monero amounts need, and writes floats as
  `repr`: `1.0`, `1e-05`, `1e+16`), in key order (a JavaScript object moves `"10"` to the front) and in escapes
  (`ensure_ascii`). So the extractors parse into an ordered tree that keeps ints and floats apart and write it as
  CPython does. Real SimpleFIN, Monero and Privacy files re-read and re-write to the same bytes, and
  `test/statements.test.ts` pins floats and escapes to CPython's.

## How an app uses it

An app registers asking for `statements` at read on the kinds it reads, connects to `/consumer`, and for each granted
account lists after its cursor, fetches each file, checks its sha256, saves it as `<dir>/<name>`, and acks. Accounts
pull by themselves daily (05:30 + jitter), so an app asks for a pull (`statements.refresh`) only when it wants one
now. dither-finance's `ledger/accounts.py` does this with a small stdlib WebSocket client: it saves under its
`data/raw/` (600; a file already there with the same bytes is skipped, with other bytes it is never overwritten and
the cursor stops before it), asks an account to pull only when its last pull is older than 18 hours, and its pull
button always asks for a pull now and waits.

## Tests

`test/statements.test.ts` (Python's JSON, the spool, the slot, the interface is read only), `test/simplefin.test.ts`,
`test/monero.test.ts`, `extractors/venmo/test` and `extractors/amazon/test` (fakes, fixtures from the Python pullers,
the real sandbox), `extractors/privacy/test` (the same, plus the passkey sign-in), `extractors/schwab/test` (a fake
Schwab, the real sandbox, Chromium's downloads).
