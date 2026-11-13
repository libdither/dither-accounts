# Passkeys held by an account

Two kinds carry **their own passkey** for their site: `privacy` for privacy.com ([privacy.md](privacy.md)) and
`schwab` for schwab.com ([schwab.md](schwab.md#its-own-passkey)). You sign in once by hand in the live view and add a
passkey in the site's settings; the account's extractor makes the key and keeps it. From then on the account signs
itself in with it. The private key never enters the browser: the page's `navigator.credentials` calls are answered
by the extractor process. This page is the part both share; each kind's page has its own steps.

## The pieces

| Piece | Where | What |
|---|---|---|
| authenticator | `packages/passkey/src/authenticator.ts` | who may ask (frame policy), the rpId rule, keys, counter, `secret.json` |
| CBOR | `packages/passkey/src/cbor.ts` | the little CBOR WebAuthn needs (COSE keys, the attestation object) |
| store, answer | `packages/passkey/src/store.ts`, `respond.ts` | `secret.json`'s `passkeys`; one request from the page answered |
| page half | `packages/browser/src/page/webauthn.js` | the `navigator.credentials` wrappers, put into a kind's `hook.js` (`include webauthn`) |
| worker half | `packages/browser/src/page/webauthn-worker.js` | the ports and routing, put into a kind's `sw.js` (`include webauthn-worker`) |

Privacy's own `hook.js` and `sw.js` include both halves. Schwab's extension is statements-common's tab driver; its
copy gets `statements-common/extension/passkeys.js` appended to the driver (`BrowserHost` `passkeys: true`), which
includes the worker half and adds the command `webauthn.answer`, and its own `hook.js` and `content.js` (content
scripts on every schwab.com frame) are the page half and the channel.

```
the site's page or frame ──navigator.credentials──▶ hook.js (MAIN world: webauthn.js)
   ▲                                                   │ CustomEvents of this install's own types (plain data)
   │ PublicKeyCredential-shaped answer                 ▼
   │                                               content.js (ISOLATED) ──port──▶ sw.js (webauthn-worker.js)
   │                                                                                │ + the frame's origin, the tab's
   │                                                                                │   page, the frames above it,
   │                                                                                │   as Chromium reports them
   └────── webauthn.answer (to that tab and frame only) ◀── extractor ◀── loopback WebSocket ┘ (token-gated)
                                                            packages/passkey: frame and rpId checks, key, counter
```

## Who may ask: the frame rule

The service worker sends up, for each request, what **Chromium** says about the port it came on (`port.sender`), never
what the page says: the frame's origin (`sender.origin`) and page, whether it is the top frame (`frameId` 0), the tab's
top page (`sender.tab.url`), and, when the extension has `webNavigation` (Schwab's has), the origins of every frame
between it and the top (`chrome.webNavigation.getAllFrames`). The authenticator (`callerFor`) then applies the kind's
frame policy:

- **`top`** (Privacy): only the tab's top frame is answered. A request from any subframe is refused.
- **`same-site`** (Schwab): the top frame, or a subframe, as long as the frame itself, every frame above it that
  Chromium reported, and the top frame are each **https** and on the kind's domain or under it (`schwab.com`,
  `*.schwab.com`). So the sign-in widget from `sws-gateway-nr.schwab.com` in a frame on `www.schwab.com` or
  `client.schwab.com` is answered; a schwab.com frame inside another site's page is not, a frame of another site is not,
  an http frame (or an http page around it) is not, and a subframe whose top page Chromium did not report is not.

Refusals are `NotAllowedError` (what Chromium's own permission checks throw); nothing is stored or counted. In tests
`domains` also names `localhost`, where http is allowed.

The page half adds the browser's own rule on top: in a frame that is not the top one, it asks the page's permissions
policy (`document.featurePolicy.allowsFeature('publickey-credentials-get' / '-create')`) and, when the frame may not use
passkeys (a cross-origin frame without `allow="publickey-credentials-get"`), leaves the call to the browser's own
`navigator.credentials`, which refuses as it would without the hook.

## The rpId rule

The rpId asked for (or the caller's host when none is) must be the **calling frame's host or a parent domain of it**
(WebAuthn's rule), and must be one of the kind's domains or under one. From `sws-gateway-nr.schwab.com`: `schwab.com`
and `sws-gateway-nr.schwab.com` are answered; `www.schwab.com` (a sibling) is a `SecurityError`; `evil.com` and
`schwab.com.evil.com` are `SecurityError` (not a parent of the frame's host) and, asked from a page of their own,
`NotAllowedError` (outside schwab.com); `com` is `NotAllowedError`.

**Related origins** (WebAuthn Level 3 related origin requests, which Chromium has had since 128): Schwab's real page
asks for rpId **`www.schwab.com` on `client.schwab.com`** (Security settings → Passkeys → Add Passkey), a sibling,
which the rule above refuses. Chromium allows it when `https://www.schwab.com/.well-known/webauthn`
lists `https://client.schwab.com` in its `origins`. A kind that passes a `related` fetcher to the `Authenticator`
(Schwab does; Privacy does not) gets the same: for an rpId inside its domains, asked from a page inside its domains
(stricter than WebAuthn, which admits any listed origin), the extension's worker fetches that file as Chromium would
(command `webauthn.related`: no cookies, no referrer, no redirects) and the caller's exact origin must be in it.
Unlisted, or the file unreachable: the same `SecurityError` as before. Nothing is fetched for a foreign rpId or a
foreign page. Schwab keeps a list that came back for an hour.

## What the authenticator answers

- **create**: the first algorithm in the site's `pubKeyCredParams` that it has (**ES256** or **Ed25519**, in the
  site's order; an empty list means ES256); a fresh key pair from WebCrypto; a 32-byte random credential id; **"none"
  attestation** (zero AAGUID, empty statement); flags UP, UV, AT; counter 0; `credProps` answered `rk: true`.
  `excludeCredentials` naming a held credential → `InvalidStateError`. The credential is saved before the answer goes.
- **get** (modal): the newest held credential for that rpId that the allow list names (any, when it names none, with
  the user handle: a discoverable credential); counter + 1, **saved before the assertion is handed out** (a failed save
  hands out nothing); flags UP, UV; never BE/BS. One operation at a time; a counter never lower than the highest this
  process has handed out. No credential that fits: the browser's own `get` runs. Conditional `get` (passkey autofill)
  is left to the browser.
- **clientDataJSON** is what Chromium writes for that frame: `{"type","challenge","origin","crossOrigin"}`, and for a
  frame that is not same-origin with every frame above it, `"crossOrigin":true,"topOrigin":"<the top page's origin>"`.
  The sign-in widget from sws-gateway in a frame on www.schwab.com is such a frame; a top-level page never is.

## Secrets

A credential can instead live on your phone, with no private key here: [approver.md](approver.md). Such a **remote**
credential is `{ id, rpId, alg: -7, publicKey, userHandle, device, createdAt, lastUsedAt, verifiedAt }` in the same
list: no `privateKey`, no `signCount` (the phone counts). The account's pane lists every passkey with where its key
lives, and **Keep new passkeys on** picks where new ones are made.

`<account>/secret.json` (mode 600, written whole: tmp file, fsync, rename; the last good copy as `secret.json.bak`):
`{ passkeys: [{ id, rpId, alg, privateKey (PKCS#8), publicKey (SPKI), userHandle, signCount, createdAt, lastUsedAt,
verifiedAt }] }`. The format is the same for both kinds. Never sent to apps
or the manager, never logged: the log has the credential id's first 8 characters, pages, counts and refusal reasons.
Status details: enrolled yes/no, how many, the id's first 8 characters, the algorithm, the rpId, days and minutes.

## Service workers

Chromium keeps running the extension worker it first registered in a persistent profile. The sandbox clears the
profile's `Default/Service Worker` when the copied worker changed (`packages/browser/src/worker.ts`; the hash
covers what the worker imports, like the finance kinds' `page.js`). A version bump alone does nothing.

## Tests

- `bun test packages/passkey`: `authenticator.test.ts` (ES256 and Ed25519 against an independent relying party,
  `fake-rp.ts`; the counter; the rpId rule; `secret.json` at mode 600) and `frames.test.ts` (the frame rule: the
  gateway frame on www.schwab.com answered with crossOrigin and topOrigin; refused: a cross-site frame either way round,
  an http frame or page, rpId evil.com and schwab.com.evil.com; Privacy's `top`).
- The kinds' browser tests run the real extension in Chromium: `extractors/privacy/test/browser.test.ts`,
  `pull.test.ts`, and `extractors/schwab/test/browser.test.ts`, where every passkey request comes from a same-site
  subframe on another origin of the fake site.
