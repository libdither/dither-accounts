# The approver: passkeys held on your phone

Two kinds hold **their own passkey** for their site (docs/passkeys.md): `privacy` and `schwab`. Today the private key
sits in the account's `secret.json` on this machine, so anything that can read that file can sign in as you, at any
time. The approver moves the key to your phone. The extractor still answers the page's `navigator.credentials`
calls, still checks who may ask and for which rpId, but the signature comes from **dither-approver**, an Android app
(apps/android) that keeps the key in the phone's secure hardware and asks for your fingerprint each time.

What it buys: the machine never holds the key, so a stolen disk or backup, a malicious dependency or a hijacked
agent session cannot sign in; and no sign-in happens without a tap on your phone, which says which account, which
site and why.

What it doesn't: someone who controls this machine **while** a job runs can use the session you approved (the
session lives here), and can show your phone a real challenge from a browser of their own (a passkey cannot tell whose
session a challenge belongs to; an unexpected prompt is the sign). Pair it with the site's own limits on moving money.

## Pieces

| Piece | Where | What |
|---|---|---|
| approver registry | `packages/manager` (`approvers.ts`), `<data>/approvers.json` (0600) | paired devices: id, name, identity public key, push endpoint, paired and last-seen times |
| pairing | the page (a new **Approvers** section), `POST /approver/pair` | a one-time code shown as a QR; the app sends its identity key with it |
| the device link | `GET /approver/ws` (WebSocket) | the app's connection: it proves its identity key, then takes requests and answers them |
| remote credentials | `packages/passkey` (`approver.ts`, `authenticator.ts`) | a stored credential with `device` and no private key; create and get go to the device |
| the extractor's way in | `packages/link` (`ask`), `packages/manager` (`supervisor.ts`) | `approver.request` from the account's extractor, answered for that account only |
| the app | `apps/android` (`org.libdither.approver`) | Keystore keys, the approval screen, the link, UnifiedPush |
| tests | `packages/passkey/test/fake-device.ts`, `test/approver.test.ts`, `test/passkey-extractor.ts` | a fake phone, a real manager, a test extractor and the fake relying party |

Everything goes over the page's own origin (https, through the reverse proxy in front of the manager). Nothing new
listens elsewhere. The phone must be able to reach that origin (a private network such as a tailnet, for example).

`/approver/pair` and `/approver/ws` are the only routes outside the page's login (docs/auth.md), and they are not for
browsers: a request with an `Origin` header is refused (403). The app sends none (OkHttp adds none).

## Pairing

1. The page's **Approvers** section → **Pair a phone** (`POST /api/approvers/pair`, behind the login). The manager makes a
   pairing: 16 random bytes, base64url (22 characters), good for 10 minutes and one use (at most 8 live at once), and the
   page shows it as a QR of
   `dither-approver://pair?url=<the page's public URL>&code=<code>` (and the text, to paste).
2. The app (scan, or paste) makes its **identity key**: P-256 in the Android Keystore (StrongBox when there is one),
   signing only, **not** gated by user authentication (it proves the device on every connection), never exported.
3. It sends `POST <url>/approver/pair` with `{ code, name, publicKey }`: `name` the phone's model unless you typed one,
   `publicKey` the identity key's SPKI, base64. Not behind the page's login: the code is the authority, checked in
   constant time, once.
4. The answer: `{ deviceId }` (`dev_` + 16 random base64url characters). The page shows the new device and its key's
   fingerprint: SHA-256 of the SPKI's bytes, the first 8 bytes as lowercase hex pairs joined by colons
   (`3f:a1:09:7c:52:e0:4b:d8`, 23 characters); the app shows the same fingerprint. Compare them.

   Errors (JSON `{ error }`): **400** a body that is not `{ code, name, publicKey }` with `name` 1 to 64 characters
   (control characters become spaces) and `publicKey` a P-256 SPKI; the code is **not** used up by a bad body. **403** a
   code that is unknown, used or expired. **409** a key that is already paired (the code is used up). **413** a body
   over 4 KiB.

**Remove** on the page (`DELETE /api/approvers/<deviceId>`) forgets a device: its link is closed (4401), whatever waits
for it is refused (`no-device`), and its credentials stop working here (the keys on the phone stay until you remove
them in the app, or in the site's settings). An account whose pane still names it as **Keep new passkeys on** makes no
new passkeys at all (not here instead) until you pick another.

## The link

The app opens `GET <url>/approver/ws` (WebSocket; not behind the page's login: the identity key is). JSON text frames,
one object each, `t` naming it.

```
server  {t:"challenge", nonce}                    nonce: 32 random bytes, base64url
device  {t:"hello", deviceId, sig, app}           sig: ECDSA P-256 / SHA-256 (DER, base64url) over
                                                  UTF-8 "dither-approver-v1\n" + deviceId + "\n" + nonce
server  {t:"ready", name}                         or closes with 4401 (unknown device or bad signature)
device  {t:"push", endpoint}                      optional: its UnifiedPush endpoint (https URL), or null to drop it
server  {t:"request", ...}                        below; any number, one at a time per device
device  {t:"response", id, ...}                   below
either  {t:"ping"} / {t:"pong"}                   every 30 s from the server; 90 s silent closes it
```

What the manager settles:
- The hello must come within 15 s. Anything the device sends before `ready` other than `hello` is ignored.
- Close codes: **4401** unknown device, bad signature, no hello in time, or the device was removed (the app should
  treat it as unpaired, not retry in a loop); **4000** replaced by a newer link of the same device; **4408** nothing
  heard for 90 s; **1001** the manager is stopping; **1009** a frame over 64 KiB.
- `push`: an endpoint that is not an https URL (at most 2048 characters) is ignored; `null` drops it. Nothing answers it.
- Any frame counts as heard. The device may send `ping` too; the server answers `pong`.
- One request at a time per device: the next is sent once the device answered the current one, or it expired. A request
  sent on a link that closes before it was answered is sent again, with the same `id`, on the next link (the app should
  show it once, and may answer it again if its first answer was lost).

The app keeps the link while it is in the foreground, and opens it when a push arrives or you open it. Requests
queue on the manager until a link takes them or they expire.

**Wake-up**: when a request waits and the device has no link, the manager POSTs to its push endpoint a body of
exactly `{"t":"wake"}`: nothing about the account, the site or the reason (push servers see it). The app then opens
the link and shows what is waiting. Headers: `content-type: application/json`, `TTL: 180`, `Urgency: high`; no
redirects, 15 s at most; at most one wake-up per device every 5 s.

## Requests

```
{ t: "request", id, op: "create" | "get",
  account: { id, label, kind },          the account asking (e.g. "Charles Schwab", schwab)
  reason,                                one line from the extractor, at most 200 characters: "Sign in for the statements pull"
  rpId,                                  as the authenticator resolved it (docs/passkeys.md: the rpId rule)
  origin,                                the calling frame's origin, as Chromium reported it
  clientDataJSON,                        the exact bytes the relying party will check, base64url
  expiresAt,                             ms since epoch: 3 minutes after it was made
  create?: { rp: { id, name }, user: { id, name, displayName }, algs: [-7] },
  get?: { allow: [credentialId, …] } }   empty allow: any of the device's credentials for rpId
```

`id` is `apr_` + 16 base64url characters. The manager fills in `account` itself, from the extractor's own socket:
an extractor cannot ask for another account. `rp.name` and the user's names are cut to 200 characters. Today's
extractors always name the one credential in `allow`.

The device **checks before it shows**:
- `clientDataJSON` parses, its `type` is `webauthn.create` / `webauthn.get` to match `op`, its `origin` equals
  `origin`, and that origin is https;
- the origin's host is `rpId` or under it, **or** both sit under the same registrable domain (Schwab asks for rpId
  `www.schwab.com` from `client.schwab.com`, a related origin the authenticator already checked against the site's
  `/.well-known/webauthn`);
- for `get`: the credential is one it holds, for that `rpId`, made through this manager (deviceId);
- not expired.

Any check failing answers `{ok:false, reason:"refused"}` without asking you, and the app keeps a line about it.

It then **shows** the account label, the site (rpId and origin), the reason, the time, and how many times it signed
for that rpId today; Approve runs the Keystore operation behind a `BiometricPrompt` (strong biometric or the device
credential); Deny answers `denied`.

### create

A new **credential key**: P-256 in the Keystore (StrongBox when there is one), signing only,
`setUserAuthenticationRequired(true)` with `setUserAuthenticationParameters(0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`
(every use asks), `setUnlockedDeviceRequired(true)`, `setInvalidatedByBiometricEnrollment(false)` (adding a finger
must not lose your bank's passkey). A 32-byte random credential id. The device keeps, per credential: id, rpId, the
manager's URL and deviceId, account label, user handle, counter, created and last-used times.

```
{ t:"response", id, ok:true,
  credentialId,                          base64url
  publicKey,                             SPKI, base64
  authenticatorData,                     base64url: rpIdHash ‖ flags (UP|UV|AT = 0x45) ‖ counter 0 (4 bytes) ‖
                                         AAGUID (16 zero bytes) ‖ credentialId length (2) ‖ credentialId ‖ COSE key
  attestationObject }                    base64url CBOR {fmt:"none", attStmt:{}, authData}
```

The COSE key is EC2 P-256: `{1:2, 3:-7, -1:1, -2:x(32), -3:y(32)}`, CTAP2 canonical CBOR (as packages/passkey's
`cbor.ts` writes it). Only ES256: the Keystore has no Ed25519.

### get

The counter for that credential + 1, saved before signing. The signature is ECDSA P-256 / SHA-256 over
`authenticatorData ‖ SHA-256(clientDataJSON)`, DER as WebAuthn wants it.

```
{ t:"response", id, ok:true,
  credentialId, authenticatorData,      rpIdHash ‖ flags (UP|UV = 0x05) ‖ counter (4 bytes, big-endian)
  signature,                             base64url, DER
  userHandle }                           base64url or null
```

### Refusals

`{ t:"response", id, ok:false, reason }`, reason one of `denied` (you said no), `refused` (a check failed),
`expired`, `unknown-credential`, `error` (with `message`, for the log). The page gets every one as the
`NotAllowedError` a cancelled prompt gives; the extractor sees the reason (below). A reason it does not know counts as
`error`. The manager has one of its own: `no-device` (the device is not paired here, or was removed while the request
waited). The manager adds `deviceName` (the device's name as paired) to every refusal it passes on for a device it
knows, so the account can say where it was refused. A request for a device that is not paired here also becomes one of the manager's own
notices (`no-device:<account>`, urgency high, [notifications.md](notifications.md)); one refused because you removed
the device while it waited does not.

### What a refusal does

A prompt nobody expected, again and again, teaches you to tap Approve. So a refusal stops the account from asking
(`packages/passkey/src/signin.ts`, used by `privacy` and `schwab` for signing in by themselves):

- The authenticator throws `ApproverRefusal` (a `NotAllowedError` with the reason and the device's name; an answer
  that does not check out is one too, reason `error`). The page's answer is unchanged: the plain `NotAllowedError`.
- If the account was **signing in by itself**, that sign-in ends at once: no second click on the site's passkey
  button, no second try (the three tries with backoff are for passkeys kept here). The pull that needed it fails with
  the attention **`approval`**, and the refusal is kept in the account's `state.json` (`approval`: reason, device,
  time), so a restart does not ask again.
- What asks again depends on the reason:

  | reason | means | the next automatic sign-in |
  |---|---|---|
  | `denied` | you said no | none: only a pull you start (the page's pull, `statements.refresh`) asks once more |
  | `refused`, `unknown-credential` | the phone's own checks failed, or it no longer holds the key | none, as `denied`; something needs fixing |
  | `expired` | nobody answered in 3 minutes | the next scheduled pull (daily or catch-up): at most one prompt per scheduled pull |
  | `no-device` | the phone is not paired here | the next scheduled pull |
  | `error` | something failed on the way (the manager stopped, the Keystore said no) | the next scheduled pull |

  Until then the start's sign-in, the runner's hourly retries (they never follow an attention anyway) and Schwab's
  pull after you sign in ask nothing. A pull you start always asks once (once: no retries).
- The account seen **signed in** ends it: a pull you started that the phone approved, or you signing in by hand in the
  live view (a sign-in you make there asks the phone as before, and its refusals stop nothing).
- The attention says which: "The sign-in to Schwab was denied on <phone>, so nothing signs in by itself any more. A
  pull from the page asks your phone once more, or sign in by hand in the live view." / "… waited for your approval on
  <phone>, and it was not answered in time. The next scheduled pull asks once more; a pull from the page asks now."
  (`<phone>` is the paired phone's name.)
  The `signed in` layer and the details' `approval` say it in short.

Passkeys kept on this machine meet none of this: their sign-ins try three times with backoff, as before.

## The manager side

- `approvers.json`: `{ devices: [{ id, name, publicKey, push, pairedAt, lastSeenAt }] }`, written whole, 0600 (tmp,
  fsync, rename, the last good copy as `.bak`, as secret.json is). Pairing codes live only in memory, as their SHA-256.
- A stored passkey (secret.json `passkeys`) may be **remote**: `{ id, rpId, alg: -7, publicKey, userHandle, device,
  createdAt, lastUsedAt, verifiedAt }`, no `privateKey`, no `signCount` (the device counts). `get` for a remote
  credential forwards to its device and waits; `create` forwards when the account's config names a device
  (`passkeyDevice: "<deviceId>"`, set on the account's pane: **Keep new passkeys on**, `PATCH /api/accounts/<id>`
  `{ passkeyDevice }`, null for here; only kinds whose manifest says `passkeys: true`). Local credentials work as before.
- The extractor reaches the manager with `link.ask('approver.request', …)`: `{t:"ask", aid, what, input}` up its
  /extractor socket, `{t:"answer", aid, ok, result | error}` back. For these kinds the manager also sends the account's config down
  as `{t:"config", config}` when the socket connects and when the pane changes it, and the link's `config` follows, so
  **Keep new passkeys on** applies without restarting the extractor. The manager also refuses a `create` for any device
  but the one the config names.
- Before an answer goes to the page, the extractor checks it: for `create`, the authenticator data is for this rpId with
  UP, UV and AT, names the credential id, and carries an ES256 P-256 COSE key equal to `publicKey`, and the attestation
  object is "none" around those same bytes; for `get`, it is this credential, this rpId, UP and UV, and the signature
  verifies with the key it registered. Anything else is a `NotAllowedError`. A site that lists algorithms but not ES256
  gets `NotSupportedError` when new passkeys go to a phone.
- The authenticator's checks (frame policy, rpId rule, related origins, excludeCredentials) all run **before**
  anything is sent; the device's checks repeat the ones it can.
- A request waits at most until `expiresAt`. While it waits the account's status says so (`attention`, kind
  `approval`: "Waiting for your approval on <device>"), and the page shows it.
- Every request and its outcome goes to the audit log (account, rpId, op, device, outcome, times; never the
  clientDataJSON or a key): the `approval` table in accounts.sqlite (the reason line, the device's error message, made,
  sent and decided times; kept 90 days; requests waiting when the manager stopped end as `error`), and the daily counts
  as app `approver`, op `passkey.create` / `passkey.get`. The page's Approvers section lists the last 50.
- The page's API, behind the login: `GET /api/approvers` (`{ devices, approvals }`), `POST /api/approvers/pair`
  (`{ code, link, url, expiresAt }`), `DELETE /api/approvers/<deviceId>`. An account's detail lists its passkeys
  (`passkeys: { device, list }`: id prefix, rpId, algorithm, the device each is on or null for here, times).
- A device's link answers only requests made for that device; responses for an unknown or finished `id` are dropped.
- Tests: a fake device in TypeScript (`packages/passkey/test/fake-device.ts` beside `fake-rp.ts`) that speaks this protocol with WebCrypto
  keys, against a real manager and the fake relying party, so CI checks every message without a phone.
  `test/approver.test.ts`: pairing (a good code once, a used, expired or unknown one, a bad body, from a browser, outside
  the login), the link (good, a bad signature, an unknown and a removed device: 4401), create and get through a test
  extractor (`test/passkey-extractor.ts`) checked by `fake-rp.ts` with the phone's counter, denied, failed and expired as
  NotAllowedError (a refusal naming the device), the account's attention while it waits, the wake-up's exact body,
  answers to unknown ids and to another device's request dropped, and the audit.
  `test/approver-signin.test.ts` (CI): what a refusal does, with the fake phone asked directly, the real authenticator,
  `PasskeySignIn` and the statements runner on fake timers: a denial is one request across the daily pull, the
  runner's retry window, Schwab's tick, a restart and the next day's pull, and a pull you start asks once more; an
  unanswered request is one prompt per scheduled pull; each reason's rule; a passkey kept here still gets its three
  tries. `extractors/privacy/test/approver.test.ts` (where Chromium is): the privacy kind in its sandbox with its
  passkey on the fake phone: denied at start (one request), nothing at a restart, a pull from the page asks once more,
  expired, then approved and pulled.

## Moving a passkey to the phone

1. Pair the phone. 2. On the account's pane, **Keep new passkeys on** your phone. 3. Sign in by hand in the live view
and add a passkey in the site's settings: the request goes to the phone. 4. Remove the old passkey in the site's
settings, then here (the pane lists both, with where each lives). Keep two devices (a second phone, or an old one in a
drawer) so losing one doesn't lock you out of a site; each site's own recovery is the last resort.
