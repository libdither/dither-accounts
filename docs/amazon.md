# Amazon orders: the `amazon` kind

`extractors/amazon` hands over your Amazon order history as `statements` files ([statements.md](statements.md)),
under the names dither-finance's parser expects in `data/raw/amazon`. It is a port of an earlier Python puller
(`amazon.py`, with `amazon_auth.py` for the sign-in), and writes the same bytes it wrote.
**Read only**: nothing here orders, cancels, returns or changes anything on Amazon.

## How it runs

- **A sandboxed browser** like the venmo kind's ([venmo.md](venmo.md)): Xvfb, an ordinary Chromium with the account's
  profile, x11vnc for the live view, no DevTools and no automation; an extension (`driver.js` + `src/extension/page.js`)
  is the only instrument.
- **A pull** drives one background tab at the Python puller's pace: Your Orders (first the bare page, for the time
  filter's years), then by year (`?timeFilter=year-Y&page=N`, 3–6 s apart): every year when backfilling, else this
  year until a page has no new order; then at most 25 order-details pages (config `details`, or
  `statements.refresh {details}`), 4–8 s apart, newest first, then orders seen earlier whose details were never read.
  Each page load waits for DOMContentLoaded and 1.5 s more. The extension reads `innerText`, `href`s and visibility;
  all the parsing is `src/amazon.ts`, a line-for-line port (Python's regular expressions with Unicode `\d`,
  `str.strip` and `splitlines`, strptime's month names, dict order). The file is
  `amazon/amazon-<UTC stamp>.json` = `json.dumps({"source": "amazon-orders", "pulled_at", "orders"}, indent=1)`.
- **Signing in again**: when a page lands on `/ap/signin`, the stored email and password (and, if stored, an
  authenticator code) are typed in: the visible field, the editor's insertText, "keep me signed in", the button; up
  to 12 tries 1.2 s apart. The secret goes to the page one field at a time over the token-gated bridge and is never in
  the extension's files or the log.
- **Anything only you can give stops the pull**: a captcha on the sign-in page, Amazon's robot check
  (`validateCaptcha`: the Python puller read that page as "no orders"; here it stops), the "I am human" checkpoint, a
  code by text or email, no stored password. What was read so far is written, the tab is brought forward in the live
  view, and the account **holds**: the attention says what Amazon wants, and every pull (daily or
  `statements.refresh`) is refused until the live view shows Amazon past it (checked every 20 s: no challenge, not a
  sign-in page). Nothing here answers a captcha or a checkpoint.
- **When it pulls**: daily at `pullAt` (05:30 + jitter), and on `statements.refresh` (`full: true` = backfill).
  Don't let another crawler read the same Amazon account on the same day: two crawlers double the captcha risk.
- **Status**: online, or the held pull's attention, or `login` when Amazon's header says signed out and no password is
  stored. Layers: display → browser → extension → signed in → pull.

## Secret and state

`secret.json`: `{ email, password, totpSecret? }` (the add form's fields). `state.json`: `orders` (id → details
read), their order, `backfilled`, and `hold`. When you already have Amazon files from before, `seed.ts` fills
`orders` once from that raw tree (`amazon/amazon-*.json`, in name order; merged with what the account already
knows), so the first pull is a daily one instead of a backfill:

```
bun extractors/amazon/seed.ts --from $FINANCE_HOME/data/raw --account-dir <account dir>
```

## Tests

- `test/amazon.test.ts`: `money` and `day` against the Python puller's `_money`/`_day` on Unicode digits, odd
  spacing and bad dates; the TOTP against RFC 6238; the details order; the status.
- `test/browser.test.ts`: the extractor in its real sandbox against the fake Amazon (`test/fake-amazon.ts`): a backfill
  with a password prompt and a daily pull after a new order, page for page and byte for byte what the Python puller
  wrote for the same fake (`test/fixtures`, made by `test/make-fixtures.ts`, which runs its own source against the
  fake through a throwaway DevTools Chromium: test tooling only); an authenticator code; the robot check and the
  checkpoint each stopping a pull, holding the account, and lifting once solved in the page; no email, password or
  authenticator secret on the wire to the manager.
