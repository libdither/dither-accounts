# The approver: passkeys held on your phone

Two kinds hold **their own passkey** for their site (docs/passkeys.md): `privacy` and `schwab`. Today the private key
sits in the account's `secret.json` on this machine, so anything that can read that file can sign in as you, at any
time. The approver moves the key to your phone. The extractor still answers the page's `navigator.credentials`
calls, still checks who may ask and for which rpId, but the signature comes from **dither-approver**, an Android app
(apps/android) that keeps the key in the phone's secure hardware and asks for your fingerprint each time.

What it buys: the machine never holds the key, so a stolen disk or backup, a malicious dependency or a hijacked
agent session cannot sign in; and no sign-in happens without a tap on your phone, which says which account, which
site and why.

The same paired devices also answer **approvals** (below): a service asks a question with a few actions, and a device
answers it, signing the answer with an approval key that never leaves it. A laptop joins as a second kind of device,
the **desk signer** (`apps/desk-signer`), which signs after the laptop's fingerprint reader reports your finger.

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
| approvals | `packages/manager` (`approvals.ts`), `packages/approval`, `packages/interfaces` (`approvals.ts`) | the built-in account `approver` and its `approvals` interface; the statement a device signs |
| the desk signer | `apps/desk-signer` | the laptop as an approver device of kind `desk` (fprintd) |
| tests | `packages/passkey/test/fake-device.ts`, `test/approver.test.ts`, `test/passkey-extractor.ts`, `test/approvals.test.ts`, `test/desk-signer.test.ts`, `test/approval-statement.test.ts` | a fake phone, a real manager, a test extractor and the fake relying party; approvals end to end; the desk signer with a fake fingerprint check |

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
device  {t:"keys", kind, approval, sig}           approvals: what it is and its approval key (below)
server  {t:"request", ...}                        below; passkey ones one at a time per device, approve ones all at once
device  {t:"response", id, ...}                   below
server  {t:"cancel", id} / {t:"intent", ...}      approvals (below)
either  {t:"ping"} / {t:"pong"}                   every 30 s from the server; 90 s silent closes it
```

What the manager settles:
- The hello must come within 15 s. Anything the device sends before `ready` other than `hello` is ignored.
- Close codes: **4401** unknown device, bad signature, no hello in time, or the device was removed (the app should
  treat it as unpaired, not retry in a loop); **4000** replaced by a newer link of the same device; **4408** nothing
  heard for 90 s; **1001** the manager is stopping; **1009** a frame over 64 KiB.
- `push`: an endpoint that is not an https URL (at most 2048 characters) is ignored; `null` drops it. Nothing answers it.
- Any frame counts as heard. The device may send `ping` too; the server answers `pong`.
- Frames after `ready` are handled one after another, in the order they came: a `pong` means everything the device
  sent before it was handled.
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
  button, no second try (the tries with backoff are for passkeys kept here). The pull that needed it fails with
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

- `approvers.json`: `{ devices: [{ id, name, publicKey, push, pairedAt, lastSeenAt, kind?, approvalKey? }] }` (`kind` and
  `approvalKey` from the device's last keys frame; a device from before approvals has neither), written whole, 0600 (tmp,
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
  passkey on the fake phone: denied at start (`signInOnStart` on; one request), nothing at a restart, a pull from the
  page asks once more, expired, then approved and pulled.

## Moving a passkey to the phone

1. Pair the phone. 2. On the account's pane, **Keep new passkeys on** your phone. 3. Sign in by hand in the live view
and add a passkey in the site's settings: the request goes to the phone. 4. Remove the old passkey in the site's
settings, then here (the pane lists both, with where each lives). Keep two devices (a second phone, or an old one in a
drawer) so losing one doesn't lock you out of a site; each site's own recovery is the last resort.

## Approvals

A service (dither-chat's hub, for a deploy, a rebuild or a merge) asks a question with a few actions; a paired device
shows it and answers, and an action that needs it comes back **signed by the device's approval key** over bytes that
name the request, its payload, what was shown and the action. The formats (the statement, the payloads, the keys file,
the CLI that asks and verifies) are dither-chat's contract, its docs/approvals.md; this is the manager's side.

### The approval key and the keys frame

Each device has a second P-256 key, its **approval key**, used only to sign statements: on the phone in the Keystore
with user authentication on every use, on the laptop in the desk signer's state directory. After `ready`, on every
link, the device sends

```
{t:"keys", kind, approval, sig}    kind "phone" | "desk"; approval: the approval key's SPKI, base64;
                                   sig: the identity key's signature (DER, base64url) over UTF-8
                                   "dither-approver-key-v1\n" + deviceId + "\n" + kind + "\n" + approval
```

The manager checks the signature and that `approval` is a P-256 SPKI, and keeps `kind` and `approvalKey` in
approvers.json; a new one replaces the old (logged). One that doesn't check out is ignored, and that link gets no
approve requests (a device that sends no keys frame, an app from before approvals, gets none either). The page's
Approvers section shows each device's kind and its approval key's fingerprint (SHA-256 of the SPKI, first 8 bytes as
hex pairs) beside the identity key's.

### The frames

```
server  {t:"request", id, op:"approve", ask, display, expiresAt}
            ask: the statement's eight asker lines, exactly as the asker made them
            display: { kind, asker, title, body, payload, urgency, actions: [{ id, label, needs: "signed"|"any" }] }
device  {t:"response", id, ok:true, op:"approve", action, message, signed, signature?}
            signed: the statement's `signed` line (ms); signature: base64url DER by the approval key over
            ask + "action <a>\nmessage-sha256 <sha256 of message, of "" when none>\ndevice <its id>\nsigned <ms>\n"
device  {t:"response", id, ok:false, reason, message?}    reason: refused (a check failed), expired, error
server  {t:"cancel", id}                                   answered elsewhere, cancelled or expired: drop it
server  {t:"intent", id, action, message}                  desk devices only: the page asked to sign this action
```

- `approve` requests are **not** one at a time: each goes to every device with an approval key whose link has sent
  its keys, as soon as it is asked, and to each other device when its next link's keys frame comes, until it is
  answered, cancelled or expires. A device with an approval key and no link is woken (`{"t":"wake"}`, as for
  passkeys). Passkey requests keep their queue.
- A device checks before it shows anything (packages/approval `checkRequest`): `ask` parses as the eight lines in
  canonical form, its `id` is the request's, `payload-sha256` is SHA-256 of `display.payload`, `display-sha256` of
  `title + "\n\n" + body`, `kind` and `asker` are `display`'s, `expires` is in the future, the actions are well formed
  and include `deny`, which needs no signature. A failed check answers `refused`.
- The manager checks each answer before it passes it on: the request still waits; the device has an approval key and
  has not refused it; the action is one offered; the message is at most 1000 characters; an action marked `signed`
  carries a signature; and a signature (also on an action marked `any`) verifies with the device's approval key over
  the whole statement the manager rebuilds from the ask it holds. An answer that fails is dropped and logged, and the
  request waits on. A good answer ends the request: `{t:"cancel"}` to every other device holding it.
- A refusal (`ok:false`) goes on to the app as an answer with `ok:false` and does not end the request: other devices
  can still answer. After `refused` or `expired` that device is not sent it again; after `error` (the desk signer's
  finger that didn't match) it keeps it, and the page can ask again.
- The manager keeps requests in memory only, each until its expiry; a restart loses them (the app asks again with the
  same ask). The audit keeps no title, body, payload or message: the `approval` table gets op `approve`, the asker as
  the account, the kind as the reason, the answering device, and as outcome `ok` (with the action as the message
  column), `denied`, `cancelled` or `expired`. The daily counts get app `approver`, account `approver`, op `approve`.

### The interface: `approvals`, on the built-in account `approver`

Like the manager's notices, `approver` (kind `approver`, label "Approvers") is an account the manager answers itself:
never a process, always online, nothing to restart or remove. An app asks for it as any interface; dither-chat's hub
asks `{ interface: "approvals", level: "write", accounts: ["approver"] }`.

```
approvals.devices   read   {}                               → { devices: [{ id, name, kind, approvalKey, fingerprint, online }] }
                                                              (kind, approvalKey and fingerprint null until a keys frame came)
approvals.ask       write  { ask, display, expiresAt? }     → { devices: n }   how many devices it went to now
approvals.cancel    write  { id, reason? }                  → {}               (an id it doesn't hold is fine)
approvals.intent    write  { id, action, message? }         → { sent: n }      desk devices online that hold it
approvals.answers   read   { ids: [...] }                   → { answers: [answer…] }   good answers of the last day
event approvals.answer     { id, ok:true, action, message, signed, signature?, statement?, device, deviceName, deviceKind }
                         | { id, ok:false, reason, message?, device, deviceName }
```

- `approvals.ask` refuses (`invalid`) an ask that fails the device's checks above, or whose `expiresAt` is not its
  `expires`; at most 200 wait at once (`limited`). The same id asked again while it waits is sent to whoever lacks it
  (other words for the same id are refused); asked again after it was answered, it answers `{ devices: 0, answered:
  true }` and sends nothing (catch up with `approvals.answers`).
- `signed` in an answer is the statement's `signed` line, whether or not there is a signature (for an unsigned answer
  it is the device's time, or the manager's when the device gave none). `statement` is the whole signed text,
  present with `signature`; an app should still check the signature with keys it trusts.
- Answers are kept in the table `approval_answer` for a day, for `approvals.answers`.

### The desk signer

`apps/desk-signer` (its README says how it runs): a small Bun daemon that is an approver device of kind `desk`.
`desk-signer pair <link>` makes its identity and approval keys (WebCrypto P-256, kept as PKCS8 in
`$DESK_SIGNER_STATE`, files 0600 in a 0700 directory) and pairs; `desk-signer run` keeps the link (backoff from 1 s to
60 s; it stops with exit 2 on 4401, not paired), sends its keys on every link, and keeps each approve request it is
sent, checked as the phone checks it. It answers **only on an intent**: an action that needs no signature at once; one
that needs a signature after the presence check, by default `fprintd-verify $DESK_SIGNER_USER`, which must exit 0 and
print `verify-match` within 30 s (`DESK_SIGNER_VERIFY`, a JSON array with `{user}` in it, replaces the command). A
finger that doesn't match answers `{ok:false, reason:"error"}` and keeps the request. `desk-signer status` prints the
device and both fingerprints.

### Tests

`test/approvals.test.ts` (CI): the built-in account in an app's list; the keys frame (kept, shown on the page and in
approvals.devices; one signed by another key, with a bad kind or a bad key ignored); ask → the fake phone signs →
the event, whose statement verifies with the approval key and not the identity key, the other phone cancelled, the
audit without the words; deny unsigned; dropped answers (a signed action unsigned, an action not offered, a signature
over another message or time, a message too long, an unknown id) while the request waits; a refusal passed on and not
resent; bad asks refused; cancel and expiry reaching every device; a wake-up and resending once the keys come; intents
going to no phone; a read-only app cannot ask; answers kept a day. `test/desk-signer.test.ts` (CI): `pair` and
`status` as commands (file modes), the link as a `desk`, an intent with a matching finger signed and verified, a
mismatch answered as an error with the request kept and then signed, an unsigned action without the check, a
cancelled request dropped, and the presence check's timeout. `test/approval-statement.test.ts`: the statement against
a vector made with dither-chat's own code.
