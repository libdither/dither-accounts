# Venmo: the `venmo` kind

`extractors/venmo` hands over your Venmo statement CSVs as `statements` files ([statements.md](statements.md)), under
the names dither-finance's parser expects in `data/raw/venmo`. It is a port of an earlier Python puller (`venmo.py`)
and writes the same bytes it wrote. **Read only**: nothing here pays, requests, transfers or changes a setting.

## How it runs

- **A sandboxed browser** (`statements-common/src/tabs.ts` over packages/browser): Xvfb, an ordinary Chromium with the
  account's profile in `<account>/profile` (its HTTP cache in `~/.cache/dither-accounts/<id>/chromium`), x11vnc for the
  live view. No DevTools port, no Playwright, no automation flags: an extension is the only instrument. Its service
  worker is `statements-common/extension/driver.js` (copied in as `sw.js`): on the extractor's word it opens a tab,
  loads a page, runs one of the kind's page functions (`src/extension/page.js`) with `chrome.scripting`, brings a tab
  forward, closes it; and it reports which page each tab is on (origin and path, never the query).
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **You sign in by hand** in the live view, as on your desktop. Nothing here types a Venmo password or answers a code.
- **A pull** opens `https://account.venmo.com/statement` in a background tab, waits 3 s and reads Venmo's `profileId`
  from the tab's URL (none: signed out, the pull is skipped as `signed-out`). Then, from that page, in the page's own
  world, the request Venmo's "Download CSV" makes: `GET /api/statement/download-v2?startDate&endDate&csv=true&profileId&accountType=personal`,
  one range at a time, 1.5 s apart (`src/venmo.ts`):
  - ranges: last month to today; when backfilling (nothing known yet, `statements.refresh {full: true}` or
    `{since: YYYY}`) also this year before last month, then whole past years back to `since` (2009), stopping after
    two years in a row with no activity;
  - a range whose bytes equal the newest file known for it is `unchanged` and not saved;
  - each file is `jsonData` from the answer, as UTF-8, saved as `venmo/venmo_<start>_<end>_<UTC stamp>.csv`
    (dither-finance's parser reads the period from that name), with `coverage` the range.
- **When it pulls**: right after you sign in (the tab you see settles on the web app for 4 s and the last pull that
  found you signed in is over 12 hours old: config `autoPullHours`), at most once per 10 minutes; daily at `pullAt`
  (05:30 + jitter); and on `statements.refresh`. Venmo ends a session after ~30 idle minutes and nothing here keeps it
  alive, so the daily pull usually finds you signed out and skips quietly.
- **Status**: online when signed in, or when the last pull that found you signed in is under `nagAfterDays` (7) old;
  otherwise the attention `login` with the live view ("sign in; the pull follows"). Layers: display → browser →
  extension → signed in → pull.

## State, and seeding it

`<account>/state.json`: `ranges` ("<start>_<end>" → the newest file's sha256 and name), `backfilled`,
`lastSignedInPull`, and a one-time `check`. When you already have Venmo files from before, `seed.ts` fills `ranges`
once from that raw tree (`venmo/`'s names and hashes, the newest file per range winning; merged with what the account
already knows), so the first pull is a daily one, not a backfill:

```
bun extractors/venmo/seed.ts --from $FINANCE_HOME/data/raw --account-dir <account dir>
```

It also picks the closed range that ends last (before the first of last month) as `check`: the first pull that finds
you signed in fetches that range once more and compares its sha256 with the seeded file (nothing is saved). The
status's `seedCheck` says `same bytes` or `different bytes` with both files' row counts; `same bytes` means the
account writes what you had.

## Tests

- `test/venmo.test.ts`: `ranges` against the Python puller's `_ranges` for 32 days and cases, and a first and a daily
  pull against the fake Venmo, request for request and byte for byte against the files that puller wrote for the same
  fake (`test/fixtures`, made by `test/make-fixtures.ts`, which runs its own source against the fake through a
  throwaway DevTools Chromium: test tooling only).
- `test/browser.test.ts`: the extractor in its real sandbox against the fake: the sign-in attention, the pull after
  you sign in, the seeded check, a signed-out pull skipped quietly with the account still online, and no profile id
  on the wire to the manager.
