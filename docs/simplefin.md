# SimpleFIN Bridge (kind `simplefin`, interface `statements`)

Your banks' and cards' transactions through SimpleFIN Bridge (bridge.simplefin.org), pulled once a day as the bridge's
own responses, for an app such as dither-finance ([statements.md](statements.md)). A port of an earlier Python puller
(`sfin.py`), writing the same bytes.
SimpleFIN is read only: nothing here (or there) can move money.

## The secret

`secret.json` is `{ accessUrl }`: the URL with Basic-auth credentials in it that a setup token is claimed for. Add an
account either with a **setup token** (the page's form; on its first start the extractor POSTs to the token's claim URL
once and replaces `secret.json` with `{ accessUrl }`, so the token, which works only once, is not kept) or with an
**access URL** already claimed (paste it from where you keep it; never print it).
The access URL never leaves `secret.json`: the log and status have only the bridge's host.

## A pull

Over the last N days (N = config `days`, default 30; `statements.refresh {days}` for one pull, `{full: true}` for
365):

- windows of 45 days back from now + 1 day with a 5-day overlap (one window for 30 days), each
  `GET <access>/accounts?version=2&start-date=<s>&end-date=<e>&pending=1`, stopping after a window in which no
  account has transactions;
- each response saved as `simplefin-<stamp>-w<i>.json`, `<stamp>` the pull's local time (`%Y%m%dT%H%M%S`), the
  bytes `json.dumps(json.load(response), indent=2)` would write (`statements-common/pyjson.ts`), with `coverage`
  `{from: s, to: e}`;
- HTTP 402 (subscription) and 403 (revoked) are attention; anything else fails the pull (retried hourly, 3 times).

`state.json` keeps the accounts' names (id, name, institution, currency) for `statements.accounts`; never balances.

The bridge has a daily request quota per token. A 30-day pull is one request; anything else that uses the same access
URL counts against the same quota.

## Tests

`test/simplefin.test.ts` against `extractors/simplefin/test/fake-bridge.ts`, whose responses are written to catch a
writer that is not Python's (raw UTF-8 and escapes, floats like `1.10` and `1E5`, `-0`, integers past 2^53,
integer-like keys). `test/fixtures/sfin-w*.json` and `windows.json` come from the Python puller (`sfin.py`) run against the same
fake (`bun extractors/simplefin/test/make-fixtures.ts`); the test checks the extractor's bytes, names and requested
windows against them.
