# Charles Schwab: the `schwab` kind

`extractors/schwab` hands an app (such as [dither-finance](https://github.com/libdither/dither-finance)) Schwab's own
exports as `statements` files ([statements.md](statements.md)): History (each brokerage and bank account) and
Realized Gain/Loss, as the CSV files those pages' **Export** buttons download. Exports, not printed pages:
schwab.com offers no PDF of those pages to download, only the print, and a print is neither reproducible nor
something an extension can make. **Read only**: the only controls it presses are the account picker, the date range,
Search and Export; it cannot trade, transfer or change a setting.

| Schwab page | File | dither-finance's parser |
|---|---|---|
| History, a bank account | `schwab/schwab-bank-<mask>-<from>-<to>-<stamp>.csv` | `ledger/parsers/schwab_csv.py`, layout bank |
| History, a brokerage account | `schwab/schwab-brokerage-<mask>-<from>-<to>-<stamp>.csv` | `schwab_csv.py`, layout brokerage |
| Realized Gain/Loss | `schwab/schwab-realized-<mask>-<from>-<to>-<stamp>.csv` | `schwab_csv.py`, layout realized |
| any page you print (Save as PDF in the live view) | `schwab/schwab-print-<stamp>.pdf` | `schwab_pdf.py` / `schwab_realized.py` |

`<mask>` is the account's last three digits as schwab.com shows them (…222); `<from>-<to>` (YYYYMMDD) is the range
the export asked for, and is left out when the file's rows went outside it (the parser then takes the rows' days).
The same data as the printed pages: History's rows (date, "as of" date, action, symbol, description, quantity,
price, fees, amount; for a bank account the running balance), so positions, lots and the money-market reinvestments
come from them, and Realized Gain/Loss's rows (closed date, quantity, proceeds, cost basis, gain, long and short term,
disallowed loss).

## How it runs

- **A sandboxed browser** like Venmo's ([venmo.md](venmo.md)): Xvfb, an ordinary Chromium with the account's
  profile, x11vnc for the live view; no DevTools port, no Playwright, no automation flags. The extension's service
  worker is `statements-common/extension/driver.js`; the kind's page functions are `src/extension/page.js`. They run
  in the page's isolated world and find controls by what they say (text, label, aria-label, placeholder), not by
  Schwab's markup.
- **Downloads**: the profile's preferences send downloads to `<account>/downloads` (700) without asking, several in a
  row allowed. A pull waits there for the file its Export sent, checks it (Schwab's header for the layout it asked for,
  the account's digits in Schwab's file name, rows inside the range), spools it and deletes it.
- **You sign in by hand** once, in the live view: Login ID and password, then the code Schwab texts (or the approval
  in its app). While Schwab asks for the code the account shows the attention `verify`; nothing here reads, types or
  answers it. After that you add the account's own passkey and it signs itself in ([below](#its-own-passkey)). Schwab asks in a frame from `sws-gateway*.schwab.com`, so the probe reads every frame the extension may reach
  (the driver's `allFrames`); on a signed-in page only a visible code field counts, never words alone. Then the pull starts by itself (when the last pull that found you signed in is over 12 hours old; config
  `autoPullHours`), at most once per 10 minutes.
- **A pull**, in one background tab, 2–5 s between steps: History at `client.schwab.com/app/accounts/history/`; for
  each account in its picker: pick it, Custom date range, From and To, Search, Export (CSV if Schwab asks which
  format). Then Realized Gain/Loss at `/app/accounts/realizedgainloss/`, the same for each account it lists.
  Ranges: History from the first of last month to today; Realized Gain/Loss this year to today; the first pull of an
  account (or `statements.refresh {full: true}`, or `{since: YYYY}`) backfills whole years from config `since`
  (default: last year) to this year, newest first, stopping after two empty years in a row. Files whose bytes were
  handed over before are not handed over again (`state.json` `seen`).
- **Files you save yourself**: anything you export, or print to PDF ("Save as PDF"), in the live view lands in the same
  Downloads and is handed over within seconds: an export named from its header and the account in its file name, a
  PDF as `schwab-print-<stamp>.pdf`. Anything else stays in `downloads/` (counted as `downloadsIgnored`). So when a
  pull cannot find a control (Schwab redesigned a page), you export by hand in the live view meanwhile, and the
  account's log lists the controls the page had (`describe`), for fixing page.js.
- **When it pulls**: right after you sign in; daily at `pullAt` (05:30 + jitter); on `statements.refresh`. Schwab ends
  idle sessions and nothing here keeps one alive: with a checked passkey a pull that finds Schwab signed out signs in
  with it first; without one it skips quietly.
- **Status**: the three steps below, then online (signed in, or signed out with a checked passkey). Layers: display →
  browser → extension → signed in → passkey → passkey sign-in → pull. Details: the passkey's facts (as Privacy's), the
  accounts seen (masks), backfills done, `downloadsWaiting`, `downloadsIgnored`, and the runner's pull facts. Logs
  pages, masks, layouts, ranges and row counts: never an amount, a balance, a description, a key, a full credential id,
  a user handle or a challenge.

## Its own passkey

As Privacy's ([privacy.md](privacy.md); the shared design is [passkeys.md](passkeys.md)): the extension carries **a
passkey for schwab.com held by this account**, so it signs itself in before each pull instead of waiting for you.

What is known about Schwab's passkeys (from users' reports; schwab.com was not looked at by a script): they are offered
on schwab.com in a desktop browser, added after a normal sign-in and then chosen on the login screen; in Chrome a
passkey sign-in reportedly skips the 2-step code. Two hosts take part, `schwab.com` and `sws-gateway-nr.schwab.com`,
so the login widget is probably served from the gateway, perhaps in a frame on www.schwab.com or client.schwab.com. So
this passkey, unlike Privacy's, **answers same-site subframes**: any frame that is https and schwab.com all the way up
to the tab's page, as Chromium reports it (passkeys.md, "the frame rule"); the rpId must be the frame's host or a
parent of it inside schwab.com (`schwab.com` from the gateway), or one whose `/.well-known/webauthn` lists the caller's
origin ([passkeys.md](passkeys.md#the-rpid-rule), related origins). Whatever algorithms Schwab lists, ES256 or Ed25519 are
made, in its order.

### What you do

Three steps, each an attention with **Open live view**:

1. **"Sign in to Schwab in the live view, as on your desktop (password, then the code Schwab sends). Next you add a
   passkey for this browser; the first pull starts by itself once you are in."** (`login`).
2. **"Signed in. Now add a passkey for this browser: in Schwab's Security Center (Login & security settings, or
   similar) find Passkeys and add one. This browser answers the passkey prompt itself (no phone, no QR code, no
   security key)."** (`passkey`). The menu path is a guess (it could not be checked); the live view shows the real
   page. Schwab may ask for your password or a code first; that is Schwab's.
3. **"Passkey added. Check that it works: log out of Schwab in the live view, then log in again and choose the passkey
   option."** (`passkey_check`; signed out, it reads "…log in to Schwab in the live view and choose the passkey
   option."). When the app settles after a passkey answer from a sign-in page, the passkey is checked.

Then the account is online, signed in or not: the `signed in` layer says "signed out for now: the passkey signs in by
itself before each pull". To revoke: delete the passkey in Schwab's security settings, then forget the account.

### Signing in by itself

Before each pull, when the account's tab is not settled on the app, it loads the accounts summary there (which goes
to the sign-in page when signed out), on every try and even when the tab already shows a sign-in page: the one Schwab leaves after logging an idle session out ("we've logged you out
… due to inactivity", "There was a problem logging you in") shows the passkey option, but clicking it asks for
nothing until the page is loaded again. Then it finds the frame whose
control's **accessible name says "passkey"** (page.js `passkey`: buttons and links, by aria-labelledby, aria-label,
text, value, title, images' alt; "sign in / log in / use / continue with a passkey" first; links to learn about, add or
manage passkeys never), waits until the page's frames have been up 3 s (a widget may show its button before its script
is up, when a click does nothing), clicks it, and clicks again after 10 s if no passkey request came, **at most two
clicks a try**. The modal `get` is answered by the authenticator (counter + 1, saved first). Signed in means the tab
then settles on the app (`client.schwab.com`, not a sign-in path) for 4 s, schwab.ts's classification. At most **two
tries**, 30 s apart; then the attention `login` ("Signing in to Schwab with the passkey did not work (why): open the
live view and log in, choosing the passkey option."). When no passkey request came, the why and the log carry what the
sign-in widget's alerts said (role alert or status, error boxes; digits as `#`, anything with an `@` left out), such
as "There was a problem logging you in". A pull whose History tab finds the session gone although the account's tab
still shows the app signs in once more.

**How often**: once per pull, that is once a day and for each pull you start, and no more. Schwab logs an idle session
out long before the next day's pull, so a session nobody uses is not worth a sign-in, and Schwab stopped asking for
the passkey after two or three sign-ins within a few minutes (more clicks did not bring it back). So:

- **At start** (config `signInOnStart`, default on) it signs in only when a pull follows: when the last pull that found
  Schwab signed in is over `autoPullHours` (12) old, and that pull starts once it is in. Each restart of the manager
  (each deploy) restarts the extractor, whose new browser has no Schwab session, so signing in at every start meant a
  sign-in per deploy. A missed daily pull is the runner's catch-up, which signs in for itself.
- **A gap**: an automatic sign-in (at start, the daily pull, its retries, the pull after you sign in) waits until
  `signInGapMinutes` (default 30; 0 for none) after the last passkey try: a click on the passkey option by itself, or
  any passkey sign-in answered, yours in the live view too. The time is `state.json` `lastPasskeyTry`, so restarts in a
  row do not each sign in. While it waits, the `signed in` layer says until when; signing in yourself in the live view
  ends the wait. A pull you start (`statements.refresh`) does not wait.

**What stops it**: a visible captcha, a code field before the passkey answered, or after it a code field or words
asking for a code or an approval (any frame). Then the account **holds**: `state.json` `hold`, every pull refused
("Schwab is waiting for you in the live view: …"), nothing typed or tried again, and the attention: `verify` (the
existing "Schwab is asking you to confirm it's you…") while the page shows the question, `login` with the same message
after. The hold lifts by itself once the live view shows Schwab signed in, and the held pull then runs.

**A passkey on your phone** ([approver.md](approver.md#what-a-refusal-does)): the phone's prompt says why ("Sign in for
the daily statements pull", "… the statements pull you started", "Sign in by itself as the account starts"). A refusal
ends the sign-in at once (no second click, no second try) with the attention `approval`, kept in `state.json`
`approval`. Denied (or refused by the phone's checks): no automatic sign-in at all, neither the daily pull, its
retries, the start nor the pull after you sign in, until a pull you start from the page (it asks once) or you sign in
by hand in the live view. Not answered in time: the next scheduled pull asks once more, and nothing in between.

### What the tests cannot check

The fake Schwab stands in for schwab.com, so these stay open: whether the passkey ceremony runs in a frame (both are
handled), the menu path in step 2, the name of the login screen's passkey option (anything with "passkey" in its
accessible name), whether Schwab's `get` is modal (answered) or only conditional autofill (left to the browser, so it
would not find this passkey), whether Schwab accepts "none" attestation from an authenticator it does not know, and
whether its frame carries `allow="publickey-credentials-get"` (without it Chromium itself would refuse in a
cross-origin frame, and so does the hook). `lastRefusal`, `page` and the log show what the account saw.

## Adding it

1. On the accounts page, Add account → Money → Charles Schwab; approve your app's `statements` read on it.
2. Sign in in its live view ([What you do](#what-you-do)); the first pull backfills last year and this year.
3. Compare the first pull's files with what your app already has for those accounts and days.

## Tests

- `test/schwab.test.ts`: page kinds, recognizing exports (CSV and History's JSON, Schwab's file names and titles),
  the files' names, ranges, the status.
- `test/browser.test.ts`: the extractor in its real sandbox against the fake Schwab (`test/fake-schwab.ts`): the
  sign-in attention, the code page as `verify` with nothing answered, the pull after you are in (a menu-style picker,
  a format dialog, a plain select, a direct download), byte for byte what the fake sent, files saved by hand (an
  export and a PDF go over, a text file stays). Then the passkey, every ceremony in a same-site frame from another
  origin of the fake (as sws-gateway's): the three attentions in turn, a passkey (ES256, all the fake offers) made in
  the settings frame and checked by the relying party (origin, crossOrigin, topOrigin, counter), log out and in with
  it; a pull that finds the session gone signs itself in, clicking a button that ignores clicks until hydrated; after
  an idle logout that leaves a sign-in page whose passkey option asks for nothing, a pull loads a fresh one; a widget
  that stops asking for the passkey (`throttled`): two tries, then the pull asks for you with the widget's alert,
  masked; a code after the passkey holds (nothing typed, pulls refused) until you are in, then the held pull runs.
  Then restarts on the same account directory: soon after a pull, no sign-in; with a pull due but a passkey try just
  before, the start waits out the gap, signs in and pulls. No key, credential id or user handle to the manager.
- `test/schwab.test.ts` also: when a start signs in, the gap, the widget's words for the log, the waiting status.
- What a refusal from a paired phone does to the sign-in (one request, nothing more until a pull you start, one per
  scheduled pull when unanswered; Schwab's tick and the runner's retries ask nothing): the repo's
  `test/approver-signin.test.ts` (CI), the rules both kinds share, and `test/schwab.test.ts` for the attention and the
  layer.
- `packages/passkey/test`: the authenticator and the frame rule ([passkeys.md](passkeys.md#tests)).
