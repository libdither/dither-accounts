# dither-approver (the Android app)

The phone half of [docs/approver.md](../../docs/approver.md): it holds the site passkeys (Schwab, Privacy.com) in the
phone's Keystore and signs the WebAuthn requests the manager forwards, after a fingerprint or the phone's PIN each
time. It also answers **approvals** (dither-chat's docs/approvals.md): a program asks a question with a few actions
(merge this, rebuild that, resume a deploy), and the phone's answer comes back signed by a key that never leaves it.
Package `org.libdither.approver`, Android 11 (API 30) and up. Hand-written Kotlin, no Play Services, no WebView.
Its dependencies: OkHttp (the link, and the public suffix list for the origin checks), the UnifiedPush connector
(wake-ups), and ZXing's core (reading the pairing QR from camera frames).

## Build and install

```
cd apps/android
ANDROID_HOME=~/Android/Sdk ./gradlew testDebugUnitTest assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk        # an emulator or a test phone
```

A debug build may talk plain http to the emulator's host (10.0.2.2) and localhost, for `tools/fake-manager.ts`; a
release build talks https only (the network security config and the link parser both say so). Releases come from
CI: a tag `approver-v<version>` builds an APK signed with the release key from the repository secrets
`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and publishes it as
a GitHub release (.github/workflows/android.yml). Without those secrets the release job stops with an error naming
the missing ones; it never publishes a release signed with a debug key. Every PR and push to master touching
apps/android runs the unit tests and a debug build (job `apk`).

## Pairing

On the manager's page: Approvers → Pair a phone. It shows a QR of `dither-approver://pair?url=<page URL>&code=<code>`
and the same link as text. On the phone, any of:

- **the system camera**, or any QR reader that opens links: the link opens the app on its Pair view;
- **Scan QR** in the app: Camera2 frames decoded on the phone with ZXing (the camera permission is asked then);
- **Paste**, or typing the link and **Use this link**.

The Pair view shows the manager's URL and the start of the code; nothing is sent until you tap **Pair**. The app
then makes its identity key (P-256 in the Keystore, StrongBox when the phone has one, no user authentication, never
exported), sends `{code, name, publicKey}` to `<url>/approver/pair`, and shows the key's **fingerprint**: SHA-256 of
the SPKI, first 8 bytes as lowercase hex pairs joined by colons (`6e:57:02:64:ae:d3:e6:3c`). Compare it with the one
the page shows beside the new device.

## The screens

- **Requests**: first every approval that waits (several at once, soonest to expire first; below), then the passkey
  request that waits, if any: Create a passkey or Sign in, the account (label and kind), the site
  (rpId), the origin it was asked from, the reason, the time it came, how many times this phone approved for that
  rpId today, the passkey (for a sign-in: its id's start and use count), the manager, and a countdown to expiry.
  **Approve** opens the system prompt (strong biometric or the device's PIN, pattern or password) with the key's
  Signature as its CryptoObject, so the Keystore itself refuses to sign without it; **Deny** answers `denied`. A
  cancelled prompt leaves the request waiting. Below: each paired manager (URL, this phone's name and device id
  there, the identity key's fingerprint, the **approval key**'s fingerprint, the link's state, Unpair) and
  **Wake-ups** (UnifiedPush on or off).
- **An approval** (on Requests): its title, kind (and urgency when not normal), who asks, the manager, a countdown to
  expiry, the body (monospace, scrolling inside its box past a third of the screen), the payload's lines, a box for a
  message (at most 1000 characters), and one button per action. An action marked 🔒 is `signed`: it opens the system
  prompt and signs with the approval key; `deny` and actions marked `any` answer at once, unsigned. A cancelled
  prompt leaves the approval waiting. On a manager whose key is a quick-approval key (below), each approval with a
  signed `approve` action has a box, **Include in Approve selected** (ticked), and with two or more such approvals
  an **Approve selected (N) 🔒** button sits above them: a confirm lists their titles, then one prompt (or none
  inside the window) signs `approve` on each, with no message.
- **Quick approvals** (on Requests, below the managers): how long one fingerprint or PIN lets the quick-approval key
  sign without asking (30 s, the default; 5 min, 1 h, 8 h, 1 day, or until the phone restarts; 8 h and longer ask
  first), when the next prompt comes, and **Ask again now**. On each manager still on the old key: **Prepare a
  quick-approval key** (below).
- **Pair**: above.
- **Passkeys**: every credential: account, rpId, id's start, created, last used, counter, where its key lives
  (StrongBox, TEE, or software on an emulator) and through which manager. **Delete** destroys the key and forgets
  the credential; remove it in the site's settings and on the manager's page too.
- **Log**: the last 100 refusals and errors, newest first (never a key or a clientDataJSON).

A request that comes while the app isn't on screen posts a notification ("Sign in: <account>", the site and reason;
on the lock screen only "A sign-in waits for your approval") that opens the app. An approval posts its own
("Approval: <title>", "Asked by <asker> (<kind>)", and how many more wait; on the lock screen only "An approval
waits").

## What the app does with a request

Before showing anything (docs/approver.md, "checks before it shows"), answering without a prompt when one fails:

- `clientDataJSON` is UTF-8 JSON, its `type` is `webauthn.<op>`, its `origin` equals the request's `origin`, and it
  has a challenge; the origin is a plain `https://host[:port]`;
- the rpId is a domain and not a public suffix; the origin's host is the rpId or under it, or both have the same
  registrable domain by the public suffix list (OkHttp's `topPrivateDomain`): `client.schwab.com` for rpId
  `www.schwab.com` passes, `alice.github.io` for `bob.github.io` does not;
- create: `rp.id` (when given) is the rpId, `-7` is among `algs`, `user.id` is 1 to 64 bytes;
- get: a credential this phone holds for that rpId, made through this manager's URL and device id, and named by
  `allow` (any of them when it is empty; the newest first);
- not expired.

A failed check answers `refused`, except an unknown credential (`unknown-credential`) and an expired request
(`expired`); each leaves a line in the Log.

**create**: a new key (P-256, StrongBox when present, `setUserAuthenticationRequired(true)`,
`setUserAuthenticationParameters(0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`, `setUnlockedDeviceRequired(true)`,
`setInvalidatedByBiometricEnrollment(false)`), the prompt, and with the unlocked key one signature over what an
assertion would sign, verified against the new public key before anything is kept, so a key that cannot sign behind
the prompt is never registered. Then a random 32-byte credential id, authenticatorData (flags 0x45, counter 0, zero
AAGUID, the COSE EC2 key), the `none` attestation object, the metadata saved, and the answer. Cancelled: the key is
deleted.

**get**: the prompt; then the counter + 1 is written to disk (app-private `state.json` through AtomicFile: a temporary
file, fsync, rename) before the signature exists; then ECDSA P-256 / SHA-256 over
`authenticatorData ‖ SHA-256(clientDataJSON)`, DER, as the Keystore produces it.

The bytes match packages/passkey's software authenticator: the unit tests compare authenticatorData, the COSE key
and the attestation object byte for byte with output made by `cbor.ts` and the authenticator's own layout.

## Approvals

**The approval key**: one per paired manager, made after the first `ready` when missing (P-256 in the Keystore,
StrongBox when the phone has one, signing only, `setUserAuthenticationParameters(0, BIOMETRIC_STRONG |
DEVICE_CREDENTIAL)`, `setUnlockedDeviceRequired(true)`, `setInvalidatedByBiometricEnrollment(false)`: the same
settings as a passkey's). Making it needs a screen lock; without one the log says so and it is tried again at the
next link. After every `ready` the app sends `{t:"keys", kind:"phone", approval:<SPKI, base64>, sig}`, `sig` by the
identity key (DER, base64url, like the hello's) over `"dither-approver-key-v1\n" + deviceId + "\n" + "phone" + "\n"
+ approval`. Unpair deletes it. If the screen lock is removed the Keystore voids it; the next try to sign says so,
and a new key (a new fingerprint) is made and sent.

**The quick-approval key**: the same, except `setUserAuthenticationParameters(30 days, ...)`: one fingerprint or PIN
lets the Keystore sign with it until the phone restarts (auth tokens don't survive a reboot) or the screen lock goes,
and only while the phone is unlocked. The window the user picks is kept by the app on top of that: the last prompt is
stored as `SystemClock.elapsedRealtime()` and `Settings.Global.BOOT_COUNT`, and a signature needs a new prompt when
there is none, the boot count differs, the clock is behind it, or the window has passed (QuickWindow.kt). A prompt is
the system one without a CryptoObject (it only opens the Keystore's window); a `UserNotAuthenticatedException` while
the app thought the window open prompts once and tries again. A new pairing gets a quick-approval key. One paired
before keeps its key, since the hosts that check answers pin it: **Prepare** makes the new key beside it and shows
its fingerprint and the keys-file line (`deviceId  phone  SPKI  fingerprint  name`, **Copy line**); after the line is
in those hosts' keys, **Switch to it** sends it in a keys frame and deletes the old key (**Discard** deletes the new
one instead). Unpair deletes both.

**A request** `{t:"request", op:"approve", id, ask, display, expiresAt}` is checked before it is shown: `ask` is
exactly the statement's eight asker lines, canonical; its `id` is the request's; its `payload-sha256` is SHA-256 of
`display.payload` and its `display-sha256` of `title + "\n\n" + body`; `kind` and `asker` equal `display`'s; it hasn't
expired; the title is one line of at most 200 characters (so the title/body boundary can't move); the payload is the
line format (printable ASCII, at most 4 KiB, its format first; a merge's six fields with full ids); and the actions are
well formed (`[a-z0-9-]{1,32}`, `needs` `signed` or `any`, none twice) and include `deny`. A failed check answers
`{ok:false, reason:"refused"}` (or `expired`) and leaves a line in the Log. A request already shown or answered is not
shown twice; `{t:"cancel", id}` drops it without an answer; at its expiry it goes away and the app answers `expired`.

**A signed action**: the system prompt with the approval key's Signature as its CryptoObject; then the statement
(the ask, `action`, `message-sha256` of the message or of "" when none, `device <this phone's id at that manager>`,
`signed <now, ms>`), ECDSA P-256 / SHA-256 over its UTF-8, checked against the key's own public key, and
`{t:"response", id, ok:true, op:"approve", action, message, signed, signature}` (DER, base64url). `message` is null
when the box is empty. **deny** and **any** actions answer the same without a prompt and without `signature`.

## The link and wake-ups

One WebSocket per paired manager to `<url>/approver/ws`: the challenge, a hello signed with the identity key over
`"dither-approver-v1\n" + deviceId + "\n" + nonce` (`app` is `android/<versionName>`), then requests, a `pong` for
each `ping`, and the push endpoint after every `ready`. It stays open while the app is on screen, while a request
waits or an answer is queued, and for two minutes after a wake-up; it reconnects with backoff (1 s doubling to 30 s)
and takes 95 s without a frame as a dead link. A close with 4401 marks the pairing as removed by the manager and stops
reconnecting (pair again). An answer given while the link is down waits and goes after the next `ready`. A request
whose id is already waiting, or was answered, is not shown twice.

Wake-ups use UnifiedPush: **Turn on** picks the distributor (ntfy or another; the app asks when there are several)
and registers; each new endpoint goes to every paired manager as `{t:"push", endpoint}` (null after Turn off). A push
whose content is `{"t":"wake"}` opens the links; anything else is ignored. The manager's wake-up isn't encrypted (it
says nothing), and nothing in it is trusted beyond "open the link".

A debug build has a receiver that does what the distributor would, from adb:

```
adb shell am broadcast -a org.libdither.approver.DEBUG_PUSH -n org.libdither.approver/.DebugPushReceiver \
  --es endpoint https://push.example.invalid/up/abc --es wake '{"t":"wake"}'
```

## Checking it on an emulator: tools/fake-manager.ts

A stand-in for the manager's two routes (in memory, nothing else of the manager):

```
bun apps/android/tools/fake-manager.ts [--port 9120] [--url http://10.0.2.2:9120] [--no-wake]
```

It prints a pairing link (open it with `adb shell am start -a android.intent.action.VIEW -d '<link>'`), takes the
pairing, checks every hello's signature, and then sends, one at a time, with real clientDataJSON for rpId
`www.schwab.com` from `https://client.schwab.com`: a get whose clientDataJSON names another origin (expects
`refused`), a create (approve it), a get for it (approve; counter 1), a get for a credential the phone doesn't hold
(`unknown-credential`), a get to Deny (`denied`), and unless `--no-wake` a get held back until a new link opens after
the current one closes (background the app, send the wake-up above; counter 2). Each answer is checked with WebCrypto
(the attestation's CBOR, flags, counter, AAGUID, credential id, the COSE key against the SPKI, the DER signature) and
again by packages/passkey's independent relying party (`test/fake-rp.ts`, node:crypto); it prints pass or fail for
each and exits non-zero on any failure. On the emulator the prompt takes the PIN: `adb shell locksettings set-pin
1234` once, then `adb shell input text 1234` and Enter when it shows.

### What was verified (2026-11-11, Android 15 emulator, x86_64 default image, no Play Services)

- Pairing from the deep link; the fingerprint on the phone equal to the one the stand-in computed.
- Every hello verified (four links across emulator restarts: the identity key and the pairing survive a reboot).
- The refused request answered without a prompt, and logged.
- create and get approved through the system prompt with the PIN: every check passed, including fake-rp's
  `register` and `authenticate` (counter 1).
- unknown-credential without a prompt; Deny answered `denied`.
- The wake-up: with the app in the background, the debug push started the app's process, which opened the link,
  sent the endpoint, took the request and posted the notification; opened and approved: counter 2, which passed
  fake-rp's counter check after two emulator restarts (the counter was on disk).
- A link from a pairing the stand-in didn't know was closed with 4401, and the app stopped reconnecting to it.
- ping/pong: every ping answered.

Two runs: one with the wake step, 12 of 14 (the two failures: the expected 4401 above, and Deny, which expired while
the emulator was down), and one without it, 9 of 9.

Not verified: a real UnifiedPush distributor (ntfy) delivering the manager's push; StrongBox and a real fingerprint
(the emulator's Keystore is software, and the prompt was answered with the PIN); the in-app QR scanner with a camera
(its decoder is unit-tested with a generated code; the emulator's camera shows no code); a release build (no
release key yet).

Known limit: Android freezes a background app's process seconds after a wake-up's broadcast ends, so the link that
a wake-up opened may drop before you answer (it did on the emulator). The notification it posted opens the app,
which reconnects, and the manager sends the waiting request again. A foreground service could hold the link through
the wait, but Android doesn't let an app start one from the background on a UnifiedPush message.

### Approvals on the emulator: `--approvals`

```
bun apps/android/tools/fake-manager.ts --port 9120 --approvals
```

After the pairing it checks the keys frame on every link (the identity key's signature, an SPKI that imports), then
sends seven approve requests at once: `bad-hash` and `no-deny` (expects `refused`), `merge` (tap Approve 🔒, then the
PIN; the signature is checked with WebCrypto against the approval key over the statement it rebuilds, with the
device id it gave and the `signed` time sent), `deploy` (tap Hold: `any`, no prompt, no signature), `rebuild` (type
"not now", tap Deny: the message comes back, no signature), `cancelled` (cancelled after 20 s: the app drops it and
never answers) and `short` (expires after 40 s: the app answers `expired`).

Verified 2026-11-20 on the Android 15 emulator, headless, with the device PIN: 13 of 13 (pair, hello and keys on two
links, the seven requests, ping/pong); the approval key's fingerprint on the manager's row equal to the one the
stand-in computed; the notification while backgrounded. Not verified: a real fingerprint (the emulator's prompt took
the PIN) and StrongBox.

### Quick approvals on the emulator: `--approvals --batch`

```
bun apps/android/tools/fake-manager.ts --port 9120 --approvals --batch
```

With an app paired before quick approvals (on the old key): it sends `first` (tap Approve 🔒, PIN). When the keys
frame brings another key (Prepare, then Switch to it), it sends `batch-1`, `batch-2` and `batch-3` (Approve selected:
one PIN for the three), then `again` once they are answered (inside the 30 s window: no prompt), then `late` 40 s
after that (past the window: one prompt). Every signature is checked against the approval key the app last sent.

Verified 2026-11-26 on the Android 15 emulator, headless, with the device PIN: 15 of 15 (an app from master approving
`first` with its old key, the upgrade keeping that key, Prepare and Switch, the batch with one PIN, `again` without
one, `late` with one). Not verified: a real fingerprint, StrongBox, a release build.

## Unit tests

`./gradlew testDebugUnitTest` (JVM, JDK keys, 56 tests). Quick approvals (QuickWindowTest): no prompt yet, inside
and at the end of each window, until restart, any window ending at a new boot count, a clock behind the last
prompt, unknown windows falling back to 30 s, the labels. Approvals (StatementTest): the statement byte for byte, the
payload, display and message hashes and the key's fingerprint against a vector made with dither-chat's
packages/approvals (statement.ts); the reference's DER signature verified here and read as r ‖ s, the JDK's DER read
the same way, malformed DER refused; the keys frame's input; and each check failing on its own (an ask with too many
or too few lines, out of order, not canonical, a bad id, kind, asker or hash; the id, payload, title or body
differing; a title that moves the boundary; kind or asker unlike display's; expired; actions without deny, with a bad
id, a bad `needs`, twice, or not objects; a malformed payload). Passkeys: authenticatorData for create and get, the COSE key and the
attestation object byte for byte against packages/passkey's output; CBOR heads for longer items; coordinates always
32 bytes; DER signatures verified over `authData ‖ SHA-256(clientDataJSON)` with the key read back from its SPKI; the
COSE key is the SPKI's point; the hello's input and signature; the fingerprint; base64url; the origin and rpId checks
(same host, parent domain, the related origin client.schwab.com for www.schwab.com, a sibling on the same site,
siblings under a public suffix, foreign hosts and schwab.com.evil.com, a public-suffix rpId, http, an origin with a
path or a user, type mismatch, clientDataJSON's origin differing, malformed JSON and base64); expiry; create's
options; the pairing link parser (encoded or not; http only in debug and only to the emulator's host); and the QR
decoder.
