# Privacy.com: the `privacy` kind

`extractors/privacy` holds one Privacy.com account in a sandboxed browser whose extension carries **its own passkey
for privacy.com**. You sign in once in the live view and add that passkey in Privacy's settings; from then on the
account can sign in with it. It is a passkey of its own: any other passkey you hold for Privacy (on a phone, in
another browser) stays separate, never shares its counter, and nothing here reads or touches it.

What it does: the sign-in, the passkey, a session check (`privacy.session`), and the `statements` interface
([statements.md](statements.md)): a pull that writes `privacy-<stamp>.json` files, the names and bytes
dither-finance's parser expects. Privacy's web sessions are short, so the account **signs itself in with its
passkey** whenever a pull finds it signed out (and once when it starts); you are asked only when Privacy wants
something a passkey cannot give. **Read only**: nothing here changes a card, pays, or moves money.

## Adding it, and what you do

On the accounts page, **Add → Privacy.com** (no fields). Its extractor starts a sandbox and opens
https://app.privacy.com/, which goes to Privacy's sign-in page. The account then walks you through three steps, each
an attention with **Open live view**:

1. **"Sign in to Privacy in the live view…"** (`login`): sign in as on your desktop: email, password, the code
   Privacy sends. Those are yours; nothing here answers them. (A passkey on your phone cannot be used from this
   browser: there is no Bluetooth for the QR flow.)
2. **"Signed in. Now add a passkey for this browser…"** (`passkey`): in Privacy open **Account → Settings →
   Security** and add a passkey. This browser answers the prompt itself: no phone, no QR code, no security key, no
   Chrome dialog. It may ask you to confirm your password or a code first; that is Privacy's.
3. **"Passkey added. Check that it works…"** (`passkey_check`): sign out of Privacy in the live view, sign in again
   and choose the passkey option. When the app opens after that, the passkey is known to work.

Then the account is **online** and every layer is ok. When Privacy signs the browser out later (its sessions are
short), the account stays online: the `signed in` layer says "signed out for now: the passkey signs in by itself before
each pull". It asks you (`login`, with the live view) only when that sign-in fails three times, or when Privacy asks
for something only you can give; see below.

To revoke it: delete the passkey in Privacy's Security settings (it shows as one of your passkeys, created on the
day you added it), then forget the account here.

## How it works

```
privacy.com page ──navigator.credentials.create/get──▶ hook.js (MAIN world, privacy.com top frame only)
   ▲                                                       │ CustomEvents of this install's own types (plain data, base64url)
   │ PublicKeyCredential-shaped answer                     ▼
   │                                                   content.js (ISOLATED) ──port──▶ sw.js
   │                                                                                    │ + the caller's origin
   │                                                                                    │   as Chromium reports it
   └──────────── webauthn.answer (to that tab only) ◀── extractor ◀── loopback WebSocket ┘ (token-gated)
                                                        packages/passkey: rpId check, key, counter → secret.json
```

- **The sandbox** (packages/browser): Xvfb, an ordinary Chromium with its profile in `<account>/profile` (keeps the
  sign-in and Privacy's "known device" cookie) and the extension copied in each start, x11vnc for the live view. No
  CDP, no Playwright, no automation flags: the extension is the only instrument.
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **The page hook** (`src/extension/hook.js`, its passkey half `packages/browser/src/page/webauthn.js`, shared with
  Schwab's: [passkeys.md](passkeys.md)) replaces `navigator.credentials.create` and `.get` for public-key
  requests and says it is a user-verifying platform authenticator (`isUserVerifyingPlatformAuthenticatorAvailable`,
  `getClientCapabilities`), so Privacy offers passkeys here. `create` is always answered by this authenticator. A
  modal `get` is answered when the account holds a credential the request allows; otherwise the browser's own `get`
  runs. A conditional `get` (passkey autofill) and anything that is not a public-key request (passwords, federated,
  OTP) are left to the browser untouched. The answer is built into objects with `PublicKeyCredential`'s prototype
  and its methods (`getTransports`, `getPublicKey`, `getPublicKeyAlgorithm`, `getAuthenticatorData`,
  `getClientExtensionResults`, `toJSON`), so `instanceof` and `JSON.stringify` work as on a real one.
- **The service worker** (`sw.js`, its passkey half `packages/browser/src/page/webauthn-worker.js`) adds the caller's origin and page from `port.sender` (Chromium's, not the page's)
  and routes the answer back to that tab and frame only.
- **What the page can see of the hook** is kept small ([page-traces.md](page-traces.md)): it talks to content.js by
  CustomEvents of this install's own types (no window messages), leaves no mark on `window`, and its
  `navigator.credentials`, `PublicKeyCredential`, `fetch` and `XMLHttpRequest` wrappers read as the natives. When the
  extractor refuses a request, or does not answer in time, the page gets Chromium's own WebAuthn error (the same
  DOMException name and message); a request the hook cannot read is left to the browser's own `create` or `get`. The
  event types are not in the source, which has placeholders: the copy made each start gets names made for this
  install and account (`packages/browser/src/markers.ts`, from the manager's own secret).
- **The authenticator** (`packages/passkey/src/authenticator.ts`, shared with Schwab's, frame policy `top`), in the
  extractor process, not in the browser: the private key never
  enters the page.
  - **rpId check**: the rpId (or the caller's host) must be the caller's host or a parent domain of it, and must be
    `privacy.com` or under it; https only. Anything else is refused (`SecurityError` / `NotAllowedError`) and nothing
    is stored or counted. Only top frames are answered.
  - **create**: the first algorithm in Privacy's `pubKeyCredParams` it has, in Privacy's order (**ES256** or
    **Ed25519**; Privacy's list has Ed25519); a fresh key pair
    from WebCrypto; a 32-byte random credential id; **"none" attestation** (zero AAGUID, empty statement); flags UP,
    UV, AT; counter 0; `credProps` answered `rk: true`. `excludeCredentials` naming a held credential →
    `InvalidStateError`. The credential is saved before the answer goes out.
  - **get**: the newest held credential for that rpId that the allow list names (any, when it names none, with the
    user handle: a discoverable credential); counter + 1, **saved before the assertion is handed out** (a failed save
    hands out nothing); flags UP, UV; never BE/BS (the key lives in one file on one machine). One operation at a
    time, and a counter never lower than the highest this process has handed out, so it only goes up.
  - The clientDataJSON's origin is the caller's, from Chromium, in Chromium's form
    (`{"type","challenge","origin","crossOrigin":false}`).
- **Signed in** is told from the tab's page: the app (app.privacy.com) on a page that is not a sign-in page
  (`/login`, `/signin`, …) for 6 s, since the app shows its home briefly before an expired session goes to `/login`.
  **Checked** means a passkey assertion handed out on a sign-in page (or while not signed in) was followed, within
  3 minutes, by the app settling signed in.

## Statements: signing in by itself, and the pull

**Signing in** (`src/main.ts` `signIn`): when a pull (daily at `pullAt`, 05:30 + jitter, or `statements.refresh`)
finds Privacy signed out, and once at start (config `signInOnStart`, default on), the extension loads the app in the
account's tab (`tab.go`, in the service worker; the page hook does it for its own origin when the worker passes it
on, which keeps it working while a profile still runs an older sw.js, see Service workers above;
the app goes to its home when signed in, to `/login` when not), and on the sign-in page the
page hook clicks the button whose name says "passkey" (Privacy's "Log in with Passkey"),
once the page has been up 3 s (it is prerendered: a click before the app hydrates it does nothing), again after 10 s
if no passkey request came, at most three clicks a try.
Privacy's modal `get` is answered by the authenticator as when you click it: counter + 1, saved first. Signed in means
the app settled for 6 s, as above. At most **three tries**, 0 s, 20 s and 60 s apart; then the attention `login`
("Signing in to Privacy with the passkey did not work (why)…").

**What stops it** (`status.ts` `challengeOf`, from the page hook's `page.state`, booleans only): a visible captcha
(reCAPTCHA, hCaptcha, Turnstile, Arkose; the invisible reCAPTCHA badge does not count); any sign-in step that is not
the plain sign-in page (`/login/tfa`, Privacy's emailed code; `/verify…`, other `/login/…`
paths); a code field once the passkey has answered. The email and password fields of the plain sign-in page are not a
question (they are always there). Then the account **holds**: `state.json` `hold` (what, message, since), the
attention `login` with the message ("Privacy asks for the code it sent you: enter it in the live view…"), and every
pull is refused with "Privacy is waiting for you in the live view: …", the daily one too. Nothing is typed or tried
again. The hold lifts by itself once the live view shows Privacy signed in (you entered the code). A sign-in where the
passkey answered and Privacy came back to the plain sign-in page counts as a failed try (it may be a refusal);
three of those ask for you.

**A passkey on your phone** ([approver.md](approver.md#what-a-refusal-does)): a refusal from the phone ends the
sign-in at once (no second click, no second try) with the attention `approval`, kept in `state.json` `approval`.
Denied (or refused by the phone's checks): no automatic sign-in at all, neither the daily pull nor the start, until a
pull you start from the page (it asks once) or you sign in by hand in the live view. Not answered in time: the next
scheduled pull asks once more, and nothing in between.

**The pull** (`src/pcom.ts`, a port of an earlier Python puller, `pcom.py`): after signing in, the tab loads
`/transactions`, where the app makes its own `GET /api/v2/transactions?limit=…&fullInfo=…&transactionFilter=…`. The
page hook notes the first such request of that page (fetch or XMLHttpRequest): its URL and the headers the app set on
it (its bearer token), **kept in the page's memory**. The extractor then asks the page for each page of
results (`txn.get`): the page fetches it with those headers and its cookies and hands back the status and body. The
query is Python's `parse_qsl` of the app's query, `update(limit=100, offset, fullInfo=true)`, `urlencode`; offset
pages back to back until a page is empty or the offset reaches `total`; passes repeated until every row the server
counts was seen (at most four: Privacy's `total` can count rows it never lists, and then a pull makes all four);
rows keyed by `transactionUuid`, each cut to the `KEEP`/`KEEP_NESTED` allowlist (card expiry, IPs, auth codes, 3-D
Secure tokens, risk scores and the funding account's balance never reach disk); sorted by
(`dateAuthorized` or "", uuid) by code point; written as `json.dumps({source, endpoint, transactionFilter,
pulled_at, total, transactions}, indent=1, sort_keys=True)` with statements-common's Python JSON, named
`privacy-<UTC %Y%m%dT%H%M%S>.json`, `dir` "" (the app's raw directory itself). A failed request fails the pull.
The bodies (with the fields the allowlist drops) pass through the extension to this process's memory only; nothing
but the allowlisted file is written, and the log has counts.

## State, and seeding it

`<account>/state.json` (no amounts, no secrets): `seed` (the newest `privacy-*.json` of an existing raw tree: name,
sha256, counts, per transaction a 16-hex hash), `discovery` (the transactions requests listed in a
`privacy_discovery.json` beside that tree: method, path, query names; a pull whose captured request has other query
names logs a warning), `checked` (the first pull against the seed: same, changed, new, gone), `hold`, `approval` (a
paired phone's refusal that stops automatic sign-ins: reason, device, time), `lastPull`. A pull takes the whole
history every run and keeps no cursor. When you already have Privacy files from before, `seed.ts` fills `seed` and
`discovery` once (stop the account first; it merges into an existing state.json and prints counts only):

```
bun extractors/privacy/seed.ts --from $FINANCE_HOME/data/raw --account-dir <account dir>
```

The status's `seedCheck` then says how the first pull compares, in counts.

## Secrets and what is shown

`<account>/secret.json` (mode 600, written whole: tmp file, fsync, rename; the last good copy as `secret.json.bak`):
`{ passkeys: [{ id, rpId, alg, privateKey (PKCS#8), publicKey (SPKI), userHandle, signCount, createdAt, lastUsedAt,
verifiedAt }] }`. Never sent to apps, never logged. The log has the credential id's first 8 characters, page paths,
counts and refusal reasons; never a key, a full credential id, a user handle, a challenge or a counter.

The status and `privacy.session` show only: passkey enrolled yes/no, how many, the credential id's first 8
characters, the algorithm, the rpId, the day it was added, when it was last used, when a sign-in with it was checked.

Layers: **display → browser → extension → signed in → passkey → passkey sign-in → pull**. `details`: `display`,
`page`, `pageKind`, `extensionAttached`, `signedIn`, `passkeyEnrolled`, `passkeys`, `credentialIdPrefix`,
`passkeyAlgorithm`, `passkeyRpId`, `passkeyCreated`, `passkeyLastUsed`, `passkeySignInChecked`,
`passkeysMadeThisRun`, `signInsThisRun`, `refusedThisRun`, `lastRefusal`, `autoSignIn` (ready, signing in, held
(what) since, failed: why), `lastAutoSignIn`, `autoSignInsThisRun`, `lastPullTransactions`, `seedFile`, `seedCheck`,
and the runner's (`lastPullAt`, `lastPullOk`, `nextPullAt`, `spoolSeq`, …). The bearer token and the app's other
headers never leave the page; the request URL is not logged.

## What is verified, and what is not

The statements half: `test/pcom.test.ts` runs the port against the fake Privacy (`fake-privacy.ts`: Python-only JSON,
rows past the allowlist, a row that lands mid-pull, a `total` with four rows never listed) and matches, request for
request and byte for byte, what the Python puller itself wrote against the same fake (`test/fixtures`, made by
`test/make-fixtures.ts`, which runs that puller's own source with its DevTools virtual authenticator: test tooling
only). `test/pull.test.ts`: the extractor in its real sandbox signs itself in at start, stays online after the session
expires, signs in again for a pull and spools that same file, then stops and holds at an emailed-code step (nothing
typed, later pulls refused) until the page is signed in; counter 3 after three sign-ins; no key, credential id, user
handle or bearer token to the manager. `test/approver.test.ts`: the same with the passkey on the fake phone
(packages/passkey/test/fake-device.ts) answering the extractor's `approver.request` asks: denied at start (one request,
no second click or try, the attention `approval`), a restart that asks nothing, a pull from the page that asks once
more, one left unanswered, then approved and pulled (counter 1 on the phone and the relying party); the rules across the
daily pull and its retries are the repo's `test/approver-signin.test.ts` (CI).

The enrollment half:

**Verified**: `packages/passkey/test/authenticator.test.ts` against an independent relying party (`fake-rp.ts`,
node:crypto, its own authenticator-data parsing): create and get for ES256 and Ed25519, Privacy's algorithm order,
rpId privacy.com and app.privacy.com from app.privacy.com, refusals for other sites and bad rpIds, excluded
credentials, the counter (every sign-in, concurrent sign-ins, a stored copy that went back, a failed save, a new
process from secret.json at mode 600), the summary holding no secret. `browser.test.ts`: the extractor in its real
sandbox (Chromium, Xvfb, x11vnc) against a fake Privacy app (`fake-privacy.ts`): sign in by password, a `create` for
another rpId refused in the page as `SecurityError`, a passkey enrolled from the settings page (Ed25519, preferred
by the fake as by Privacy) and checked by the relying party, the page's object shape, sign out, sign in with the
passkey (counter 1), each of the three attentions seen in turn, then online with every layer ok, `privacy.session`,
and no key, credential id or user handle on the wire to the manager. `status.test.ts`, `manifest.test.ts`.

**The real Privacy**: a passkey (Ed25519) enrolls and signs in. What would break if Privacy changed it:

- which algorithms Privacy's `create` asks for, and whether it accepts "none" attestation from an authenticator it
  does not know;
- whether Privacy's settings page calls `create` straight away or first checks
  `isUserVerifyingPlatformAuthenticatorAvailable` / `getClientCapabilities` (both say yes here);
- whether its passkey sign-in is a modal `get` (answered here) or only conditional autofill (left to the browser, so
  it would not find this passkey; the fix is to answer conditional requests too);
- the app's sign-in paths (`/login`); a sign-in page on another path would read as signed in.
  `page` and `pageKind` in the details show what the account saw.

If Privacy refuses the passkey, it says so in the page, and `lastRefusal` or the log says why when the refusal is
ours.

## Tests

- `bun test packages/passkey`: the authenticator (shared with Schwab), its rpId and frame rules.
- `bun test extractors/privacy`: the status steps (and challenges), the manifest, the pull's port
  (`pcom.test.ts`), and the browser tests (`browser.test.ts`, `pull.test.ts`; skipped without Xvfb, chromium and
  x11vnc).
- `bun extractors/privacy/test/make-fixtures.ts`: remakes `test/fixtures` from the Python puller (needs that
  puller's source and Python environment, which are not in this repo, and Chromium).
