# Proton Mail: the `proton` kind

`extractors/proton` holds one Proton Mail account signed in to the real Proton web app in a sandboxed browser on this
machine, and answers the `mail` interface (`packages/interfaces/src/mail.ts`) from it: mailboxes, listing, reading,
attachments, search, keeping up with changes, flags, moving and trash. It works on a free plan: no Proton Bridge (which
is paid-only). The `imap` kind's Proton Bridge preset stays for paid plans (docs/mail.md).

It is built as the `google` kind is (docs/google.md): packages/browser's sandbox (Xvfb, an ordinary non-headless
Chromium with a persistent profile, x11vnc for the live view) and an MV3 extension. What is new here is the
decryption: Proton's servers keep your mail encrypted to your keys, so bodies and attachments are opened in the
extractor with keys that the signed-in session unlocks. And, as the Discord extractor hooks Discord's client, the
extension hooks the Mail web app's own modules (below, "The hook into Proton's modules"): its crypto proxy, its API
caller, its store and its choice of an address's keys. Through them the keys can also be opened in the page when the
saved-session unlock fails, and mail is sent. Proton's composer send functions are not reachable on today's
mail.proton.me (its build folds them into one module that exports nothing), so `mail.send` sends a **safe subset** with
its own code, in Proton's formats: Proton users get it encrypted to their key, outside addresses with no key get it in
the clear, and every other case (a contact with encryption settings, an outside address with a key, Proton's warnings,
settings that sign outside mail) is refused before anything is made, with a 422 whose code says why. See "Sending".

## Adding it, and what you do

On the accounts page, **Add → Proton Mail** (no fields). Its extractor starts a sandbox, and the account says **Sign in
to Proton in the live view (tick "Keep me signed in")**. Open the live view and sign in as on your desktop: password,
second factor, any human check Proton shows (those are yours to do; nothing here answers them). Tick **Keep me signed
in**, so the session survives the browser restarting; without it the account works until the extractor restarts, and
its "signed in" layer says the session is not kept. Leave the browser on Proton Mail. The account goes online once
your keys open.

## What runs

- **The sandbox** (packages/browser): a private Xvfb display (:80–:89, then :100–:159), Chromium with its profile in
  `<data>/accounts/<id>/profile` (which keeps the sign-in), the extension copied to `<id>/extension` each start, and
  x11vnc on `<id>/vnc.sock` (no TCP port) for the live view. No CDP, no automation flags: the extension is the only instrument.
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **The extension** (`src/extension`): content scripts only on `https://mail.proton.me/*`, never on account.proton.me
  (the sign-in pages run nothing of ours). `hook.js` runs in the page (MAIN world), `content.js` relays (ISOLATED world),
  and the service worker holds the one token-gated loopback WebSocket to the extractor and reports which page each
  tab is on (origin and path only).
- **What the page can see of the hook** is kept small ([page-traces.md](page-traces.md)): it talks to content.js by
  CustomEvents of this install's own types (no window messages), its `fetch` wrapper reads as the native, the module
  factories it wraps read like the app's own and carry no mark, and its probe chunk leaves the app's chunk list again.
  The names it does use (the event types, the key it tells translation bundles by) are not in the source, which has
  placeholders: the copy made each start gets names made for this install and account
  (`packages/browser/src/markers.ts`, from the manager's own secret).
- **The hook** watches the Mail app's own `fetch` calls to `/api/…` and keeps only the values of `accept`,
  `x-pm-appversion` and `x-pm-locale`, the names of the other headers, `x-pm-uid` (kept in the page, to compare) and the
  calls' statuses. It reads the app's persisted session for the page (`ps-<localID>`, the localID being the `/u/<n>/`
  in the address). It also hooks the app's modules (next section). It answers: `api` (one call to Proton's API, below),
  `storage` (the persisted session's sealed blob, its payload version and UserID; never the UID), `pagekeys` and
  `decrypt` (the keys opened in the page, when the saved session will not open), and `send` ("Sending").
- **Calls** go to `https://mail.proton.me/api/<path>` from inside the page, as the app's own: `credentials: 'include'`
  (the `AUTH-<UID>` cookie on `/api`), `mode: 'cors'`, `redirect: 'follow'`, and the headers copied from the app's own
  latest call (`accept: application/vnd.protonmail.v1+json`, `x-pm-appversion: web-mail@<version>`, `x-pm-locale`)
  plus `x-pm-uid: <UID>` from `ps-<localID>`, and `content-type: application/json;charset=utf-8` with a body. Nothing
  else: no Authorization header (the web app sends a Bearer token only for sessions that are not cookie sessions). A
  call waits (up to 20 s) for the app to have made a call of its own, so there are headers to copy.
- **Refresh**: the hook never refreshes the session. On a 401 it waits (up to 45 s) for one of the app's own calls to
  succeed after it (the app refreshes when its calls get a 401, under a cross-tab lock of its own), then tries once
  more. A 401 after that means Proton signed this browser out.
- **Decryption** is in the extractor (`src/pgp.ts`, with openpgp 6.3.2, LGPL-3.0+): the key password and the opened
  keys are kept in its memory only. They cross only the loopback bridge (as the sealed blob and the ClientKey), and
  are never written to disk or logged. When that unlock fails, the page decrypts instead (below), and only the
  plaintext asked for crosses the bridge.
- **Refusals** are logged with the method, the path with ids taken out, the HTTP status, Proton's `Code` and its
  `Error` text (`GET mail/v4/messages/count: 422 code 9001 (…)`). Never a body.

## The hook into Proton's modules

`src/extension/hook.js`, as `extractors/discord/src/extension/hook.js` does for Discord: it takes webpack's require from
inside the page and finds the app's own modules by their shape, never by module id (ids change with every build).

- **Webpack.** The Mail app is one webpack build with one runtime (`runtimeChunk: 'single'`) on the global
  `webpackChunkproton_mail`. The hook, at document_start, watches that global; when the runtime installs its `push`, it
  pushes a probe chunk, whose callback the runtime hands its require. Proton's runtime keeps its module cache private
  (`__webpack_require__.c` is not there), so the hook wraps every module factory before it first runs (the ones there,
  and through a prototype on `__webpack_require__.m` the ones later chunks add), keeping each module object, and reads
  their exports when it looks. It never runs a module itself and never touches the push chain the runtime builds.
- **Finding.** Every module's exports, and each export's values, are tried against these shapes (every 250 ms while the
  app loads, then every second, then every 10 s, until all are found):

| name | what it is (WebClients) | its shape | used for |
|---|---|---|---|
| CryptoProxy | `CryptoProxy` (`@protontech/crypto`, `src/proxy/proxy.ts`) | an object with `setEndpoint`, `encryptMessage`, `decryptMessage`, `generateSessionKey`, `encryptSessionKey`, `decryptSessionKey`, `importPublicKey` | decrypting in the page; the draft and its attachments |
| AppApi | the thunk argument, `extraThunkArguments` (`applications/mail/src/app/store/thunk.ts`, filled by `extendStore` in `bootstrap.ts`) | an object with an `api` function and an `authentication` with `getUID` and `getLocalID` | the app's own API caller (its UID, refresh, human-check and error handling) |
| Store | the app's Redux store (`setupStore`, given to `ProtonStoreProvider`) | on the React tree: the `store` prop under `.app-root`'s `__reactContainer$…`, with `dispatch`, `getState`, `subscribe`; kept only if dispatching a thunk to it hands back the thunk argument (which is then AppApi) | dispatching the app's thunks; its addresses, mail settings, contacts |
| AddressKeysByUsage | `getAddressKeysByUsageThunk` (`packages/account/addressKeys/getAddressKeysByUsage.ts`) | one argument, its source naming `withV6SupportForEncryption`, `withV6SupportForSigning`, `AddressID` | an address's keys as the app picks them: decryption keys, the encryption key, signing keys |

  These four are the **app modules**: what the page-side unlock and sending stand on. The hook reports names and found
  or not, and counts (runtimes, modules installed, modules run); nothing else. An earlier version also looked for six
  of the composer's send functions (`getEncryptionPreferencesThunk`, `getSendPreferences`, `generateTopPackages`,
  `attachSubPackages`, `encryptPackages`, `sendFormatter`) to send through; the live build does not expose them (next
  section), so they were dropped for the safe subset ("Sending"), and the hook no longer looks for them.

### What the live bundle shows (and what only a signed-in page will)

Read from `https://mail.proton.me/` on 2026-11-07 (signed out; `APP_VERSION 5.0.140.12`): the runtime
(`runtime.309f6a4d.js`), the index chunk (`index.4d457136.js`, 937 modules) and the lazily loaded `MainContainer` chunk
(`MainContainer.b812687d.chunk.js`, 436 modules), with their public source maps (which carry the sources).

- **Confirmed:** one runtime on `webpackChunkproton_mail`, no `__webpack_require__.c`, exports defined with
  `__webpack_require__.d` in its array form, lazy chunks loaded with subresource integrity. In the index chunk, each its own
  module with an export: the CryptoProxy (with every method above), `extraThunkArguments` (an empty object until
  `extendStore` fills it after sign-in), `getAddressKeysByUsageThunk` (`e=>{let{withV6SupportForEncryption:t,
  withV6SupportForSigning:r,AddressID:o}=e;return async(e,s)=>…}`), `ProtonStoreProvider`, React 18.3.1, the app mounted
  with `createRoot(document.querySelector('.app-root'))`. The extension, run once against the signed-out page in a
  throwaway profile: the probe reached the runtime, 939 modules were recorded as they ran, and CryptoProxy and
  AddressKeysByUsage were found by shape; the app then went on to account.proton.me as usual.
- **Not reachable:** the whole send path. In the MainContainer chunk, the composer, `getSendPreferences`,
  `extractEncryptionPreferences`, the package helpers and the encryption-preferences thunk are all concatenated into
  one module of 1994 source files whose only export is the `MainContainer` component. Worse for any other way in: the
  minifier inlined `getEncryptionPreferencesThunk` into the `useGetEncryptionPreferences` hook and `sendFormatter` into
  `useSendMessage`'s callback, so two of them are not even functions of their own. Their logic is the same as WebClients
  at 51f1c79 (the live sources and the repo's differ only in import paths).
- **Only a signed-in page shows:** AppApi (the thunk argument is filled after sign-in), the Store (the React tree is
  rendered only then), and the page-side unlock and the safe-subset send working against the real store, thunk and
  crypto proxy. Your checklist below checks each.

Three ways to send were weighed: loading a patched copy of the MainContainer chunk that hands the hook the composer's
functions (the genuine chunk's text with code added, loaded as a `blob:` script; the two inlined ones would have to be
cut out of the hooks they sit in), driving the real composer in the page, or doing Proton's part with our own code for
only the cases whose outcome is unambiguous. The first two change or steer Proton's running code far more than reading
its modules does; the third is used, the safe subset ("Sending").

## The session and the keys

How the key password gets out of the browser, step by step (`src/session.ts`, `src/main.ts` `unlock()`):

1. `localStorage['ps-<localID>']` is JSON: `{ UserID, UID, blob, payloadVersion, persistent, trusted, accessTypeMask,
   persistedAt, … }`. `persistent: false` is a session signed in without "Keep me signed in".
2. `GET /api/auth/v4/sessions/local/key` (with `x-pm-uid`) answers `{ ClientKey }`: base64 of 32 bytes, an AES-256-GCM
   key that only the server keeps for this session.
3. `blob` is base64 of `iv ‖ ciphertext‖tag`, opened with the ClientKey:
   - payloadVersion 1: a 16-byte IV, no additional data, the plaintext a "binary string" (one byte per character);
   - payloadVersion 2: as 1, with additional data `session` (UTF-8);
   - payloadVersion 3 (what the app writes now): a 12-byte IV, additional data `session`, UTF-8.

   The plaintext is `{ "keyPassword": …, "offlineKeyPassword"?: … }`.
4. `GET /api/core/v4/users` → `User.Keys[]`: armored private keys locked with the key password. The first (primary)
   must open, or nothing does; the others that open are kept.
5. `GET /api/core/v4/addresses?Page=0&PageSize=50` (more pages while `Total` says so) → `Addresses[].Keys[]`. Each
   address key's passphrase is: with `Token` and `Signature` (every account made or migrated since 2021), the text of
   `Token` (an armored message encrypted to the user key), whose detached `Signature` must verify with the user key;
   with `Activation`, the text of that message (encrypted and signed by the user key); with neither (a legacy
   account), the key password itself. Address keys that do not open are skipped.
6. Bodies and attachments are decrypted with every opened address key (openpgp picks the one the message names). A
   message no key opens makes the extractor unlock again once (a key added since), then answers 422.

openpgp runs with the settings old Proton keys need: decryption with signing-only RSA keys allowed (messages from
2015–16), reformatted keys' signatures accepted, any curve, RSA down to 1023 bits, v5 entities parsed.

### When the saved session will not open: the page's crypto proxy

The saved-session unlock above stays the first way in. When it fails for a reason that will not pass by waiting (no
blob, a payload version this does not know, a blob the ClientKey does not open, the ClientKey call refused with a 4xx
other than 401/403/429, the key password not opening the primary user key, a session of another user, an
organisation-managed account), the extractor turns to the page:

- `pagekeys`: for each of the account's addresses (from the app's store), the hook dispatches the app's own
  `getAddressKeysByUsageThunk` on the app's store and counts the decryption keys it gets back. It answers counts only.
- `decrypt`: a body (armored) or an attachment (its key packets and data packet), decrypted by the app's CryptoProxy
  with those keys (the message's address first, then the others), the plaintext returned as base64.

**Why this one.** The keys stay where the app keeps them: the hook holds only the app's key references (handles into its
crypto worker), nothing about a key leaves the page, and this side learns counts and the plaintext of what it asked
for, as it would after decrypting itself. The alternatives were worse: exporting the private keys out of the page
(`CryptoProxy.exportPrivateKey`) moves key material over the bridge; reading the key password from the app's
`authentication` moves the one secret that opens everything, and leans on a store the app does not mean to share. The
keys used are the ones the app itself opens a message with, so whatever Proton does to them (new key versions,
organisation keys, forwarding keys) the page handles.

It needs the app modules (CryptoProxy, AppApi, Store, AddressKeysByUsage); the unlock waits for them while the page
loads. The **keys unlocked** layer says which way it went: "… address keys …, from the saved session", or "through the
page's crypto proxy (N keys on M of K addresses); the saved-session unlock failed: <why>". `details.unlockPath` is
`session` or `page`, `details.sessionUnlockError` the reason. A message no key opens makes it unlock again once (the
saved session first).

### Where each fact came from

From ProtonMail/WebClients (GPL-3.0; read at commit 51f1c79, 2026-11-07; nothing copied, the formats reimplemented):

| fact | source |
|---|---|
| `ps-<localID>` and its fields, payloadVersion 1/2/3, additional data `session` | `packages/shared/lib/authentication/persistedSessionStorage.ts` |
| the blob's AES-GCM layout: 16-byte IV and binary string (v1/v2), 12-byte IV and UTF-8 (v3) | `packages/shared/lib/authentication/sessionBlobCryptoHelper.ts`; `@protontech/crypto` 2.2.0 (npm, from ProtonMail/WebPackages) `src/subtle/aesGcm.ts` |
| the ClientKey: base64 of 32 bytes, imported as a raw AES-GCM key | `packages/shared/lib/authentication/clientKey.ts`, `aesGcm.ts` |
| `GET auth/v4/sessions/local/key` → `{ ClientKey }`, called with `x-pm-uid` when the app resumes a session | `packages/shared/lib/api/auth.ts` (`getLocalKey`), `authentication/persistedSessionHelper.ts` (`resumeSession`), `authentication/interface.ts` (`LocalKeyResponse`) |
| the user keys open with the key password; the primary first | `packages/shared/lib/keys/getDecryptedUserKeys.ts` |
| address key passphrases: Token + Signature (verified), Activation, else the key password | `packages/shared/lib/keys/addressKeys.ts` (`getAddressKeyPassword`, `decryptAddressKeyToken`), `keys/memberToken.ts`, `keys/getDecryptedAddressKeys.ts` |
| openpgp settings for old keys | `@protontech/crypto` 2.2.0 `src/pmcrypto/openpgp.ts` |
| default headers `accept`, `x-pm-appversion: <clientID>@<version>`; `x-pm-uid`; `x-pm-locale` | `packages/shared/lib/api.ts` (`configureApi`), `fetch/headers.ts`, `api/createApi.ts` |
| fetch options: `mode: 'cors'`, `credentials: 'include'`, `redirect: 'follow'`; arrays as `key[]=v` | `packages/shared/lib/fetch/fetch.ts`, `fetch/helpers.ts` |
| the app refreshes on 401 under a cross-tab mutex (IndexedDB, cookie fallback) | `packages/shared/lib/api/helpers/refreshHandlers.ts`, `api/helpers/mutex.ts`, `api/auth.ts` (`setRefreshCookies`: the refresh cookie is on `/api/auth/refresh`) |
| mailbox label ids, label types | `packages/shared/lib/constants.ts` (`MAILBOX_LABEL_IDS`, `LABEL_TYPE`), `api/labels.ts` |
| message metadata and full message fields, attachments' `KeyPackets`, `Headers`, `Disposition` | `packages/shared/lib/interfaces/mail/Message.ts`, `mail/constants.ts` (`MESSAGE_FLAGS`) |
| `GET mail/v4/messages` params; `mail/v4/messages/count` → `Counts`; `GET mail/v4/messages/<id>`; read, unread, label, unlabel, delete | `packages/shared/lib/api/messages.ts`, `packages/mail/store/counts/messageCountsSlice.ts` |
| list paging: first `Page`/`PageSize`/`Limit`, then `Anchor` (the last element's Time) and `AnchorID` | `applications/mail/src/app/store/elements/helpers/elementQuery.ts` |
| a body: one armored message; `multipart/mixed` is PGP/MIME (a whole MIME message inside) | `packages/mail-message/src/helpers/message/messageDecrypt.ts` |
| an attachment: the session key from `KeyPackets`, the data packet from `GET mail/v4/attachments/<id>` | `packages/mail-message/src/helpers/attachment/attachmentLoader.ts`, `api/attachments.ts` |
| `ExternalID` is the Message-ID without brackets; `ParsedHeaders['In-Reply-To']` | `applications/mail/src/app/helpers/encryptedSearch/esBuild.ts` |
| lists and events carry `MessageMetadata` (no `ParsedHeaders`, no `UnsubscribeMethods`); only a whole `Message` has them | `packages/shared/lib/interfaces/mail/Message.ts` (read at `main`, 2026-11-07); go-proton-api `message_types.go` (`MessageMetadata` vs `Message`) |
| an address's `Send`, `Receive`, `Status` (0 disabled, 1 enabled), `Order`, `DisplayName`; one sends when enabled and `Send` is 1, in `Order` (as the hook picks a sender) | go-proton-api `address_types.go` (`Address`, `AddressStatusEnabled`); `extension/hook.js` `send` |
| events: `core/v4/events/latest`, `core/v5/events/<id>` with `ConversationCounts`, `MessageCounts`, `OnlyInInboxForCategoriesCounts`, `CalledFrom`, `Trigger` | `packages/shared/lib/api/events.ts`, `applications/mail/src/app/bootstrap.ts`, `packages/account/bootstrap/index.ts`, `packages/shared/lib/eventManager/eventManager.ts`, `eventLoopParams.ts` |
| message events `{ ID, Action, Message & { LabelIDsAdded, LabelIDsRemoved } }`, actions 0 delete, 1 create, 2 update, 3 flags | `packages/mail-message/src/models/event.ts`, `constants.ts` (`EVENT_ACTIONS`) |
| `Refresh & 1` (mail) means start over | `packages/shared/lib/errors.ts` (`EVENT_ERRORS`), `applications/mail/src/app/helpers/encryptedSearch/mailESCallbacks.tsx` (Proton's own second reader of the event loop, which is what this is) |
| server search with `Keyword`; bodies searched only by the browser's own index | `api/messages.ts`, `mail/search.ts`, the `encrypted-search` package |
| the thunk argument (`extraThunkArguments`), filled by `extendStore({ config, api, authentication, … })` after sign-in | `applications/mail/src/app/store/thunk.ts`, `store/store.ts`, `bootstrap.ts` |
| the store given to `ProtonStoreProvider`; the app mounted on `.app-root` | `packages/redux-shared-store/sharedProvider.tsx`, `applications/mail/src/app/index.tsx` |
| an address's keys by usage (decryption keys, the encryption key, v4 signing keys) | `packages/account/addressKeys/getAddressKeysByUsage.ts`, `applications/mail/src/app/hooks/message/useGetMessageKeys.ts` |
| the composer's send: last-minute preferences (lifetime 0, the contacts map), errors and warnings (only the API's `Warnings` ask you; key warnings do not), the order: draft, files, packages, form | `packages/mail-composer/src/hooks/composer/useSendVerifications.tsx`, `useSendMessage.tsx`, `helpers/send/*` (in the live build `applications/mail/src/app/hooks/composer/` and `helpers/send/`) |
| a recipient's preferences: your own addresses (those that receive, matched in Proton's canonical form: no `+alias`, no `.`, `_` or `-`, lower case) use that address's own primary key and ask the API nothing; others are looked up lower-cased | `packages/mail/store/messages/encryptionPreferences.ts` (`getEncryptionPreferences`; `preferV6Keys` is true for mail), `packages/shared/lib/helpers/address.ts` (`getSelfSendAddresses`), `helpers/email.ts` (`canonicalizeEmail`) |
| `core/v4/keys/all` with `Email` and `InternalOnly: 0`; `Address.Keys` (a Proton address), `Unverified.Keys` (WKD and KOO keys, `Source` 1 and 2; Proton's own are 0), `CatchAll`, `ProtonMX`, `Warnings`; a key flagged `EMAIL_NO_ENCRYPT` (4) is not for mail, and a Proton address with no key for mail is "E2EE disabled", which Proton sends to in the clear | `packages/shared/lib/api/keys.ts` (`getAllPublicKeys`), `packages/key-transparency/lib/keys/getAndVerifyApiKeys.ts`, `getPublicKeysEmailHelperWithKT.ts`, `getPublicKeysEmailHelper.ts`, `packages/shared/lib/keys/keyFlags.ts`, `interfaces/EncryptionPreferences.ts` (`GetAllPublicKeysResponse`), `constants.ts` (`KEY_FLAG`, `API_KEY_SOURCE`, `RECIPIENT_TYPES`) |
| which key: sorted by (weightiest first) untrusted, compromised, obsolete, not primary, not the preferred version (v6 for mail); the first must be neither compromised nor obsolete and able to encrypt, or Proton errors | `packages/shared/lib/keys/publicKeys.ts` (`sortApiKeys`, `getIsValidForSending`, `getContactPublicKeyModel`), `helpers/object.ts` (`toBitMap`), `mail/encryptionPreferences.ts` (`extractEncryptionPreferencesInternal`, `…OwnAddress`) |
| contacts: the store's map, else `contacts/v4/contacts/emails?Email=`; `Defaults` 1 means no settings of its own; otherwise the signed card (type 2) of `contacts/v4/contacts/<id>` and its `KEY`, `X-PM-ENCRYPT`, `X-PM-ENCRYPT-UNTRUSTED`, `X-PM-SIGN`, `X-PM-SCHEME`, `X-PM-MIMETYPE` for the email's group | `packages/shared/lib/api/helpers/getPublicKeysVcardHelper.ts`, `api/contacts.ts`, `contacts/keyProperties.ts`, `constants.ts` (`CONTACT_CARD_TYPE`) |
| settings: `Sign` signs outside mail (PGP/MIME or inline instead of `SEND_CLEAR`); `Sign` with `PGPScheme` 8 makes every recipient's MIME type plain text; `AttachPublicKey` adds your key as a file; `AutoSaveContacts` and `DelaySendSeconds` go in the form; `mail/v4/settings` | `packages/shared/lib/api/helpers/mailSettings.ts` (`extractSign`, `extractScheme`, `extractDraftMIMEType`), `mail/send/sendPreferences.ts` (`getPGPSchemeAndMimeType`), `mail/send/getSendPreferences.ts`, `mail-composer/src/hooks/composer/useSendModifications.tsx`, `api/mailSettings.ts` |
| the packages for types 1 and 4: one per MIME type wanted, `Flags` with `FLAG_RECEIVED`, `Type` the OR of its addresses'; `SEND_PM` is `{ Type: 1, Signature: 1 when every attachment is signed, else 0 }`, `SEND_CLEAR` `{ Type: 4, Signature: 0 }`; the body under one session key made for your key and theirs, signed with your address keys; a `BodyKeyPacket` and `AttachmentKeyPackets` per recipient key, and `BodyKey`, `AttachmentKeys` (`{ Key, Algorithm }`) when the type has 4 | `packages/mail-composer/src/helpers/send/sendTopPackages.ts`, `sendSubPackages.ts` (`sendPM`, `sendClear`, `getSignatureFlag`), `sendEncrypt.ts` (`encryptDraftBodyPackage`, `encryptAttachmentKeys`), `packages/shared/lib/mail/messages.ts` (`addReceived`), `constants.ts` (`PACKAGE_SIGNATURES_MODE`, `AES256`) |
| the form: `Packages[<mime>][…]` with bytes as blobs, `DelaySeconds` when set, `AutoSaveContacts`, no `ExpiresIn`, `POST mail/v4/messages/<id>` | `packages/mail-composer/src/helpers/send/sendFormatter.ts`, `packages/shared/lib/api/messages.ts` (`sendMessageForm`) |
| the draft and its files | `applications/mail/src/app/helpers/message/messageExport.ts` (`createMessage`), `messageDraft.ts` (`createNewDraft`), `packages/shared/lib/api/messages.ts` (`createDraft`, `sendMessageForm`, `deleteMessages`), `api/attachments.ts` (`uploadAttachment`), `mail/send/attachments.ts` (`encryptAttachment`) |
| CryptoProxy's methods and their options | `@protontech/crypto` 2.2.0 `src/proxy/proxy.ts`, and their uses in the files above |
| package types: 1 Proton, 2 encrypted to outside, 4 clear, 8 PGP inline, 16 PGP/MIME, 32 clear PGP/MIME | `packages/shared/lib/mail/mailSettings.ts` (`PACKAGE_TYPE`) |

From the live public bundle (`https://mail.proton.me/` and `/assets/static/index.4d457136.js`, fetched 2026-11-07,
signed out; what the hook relies on is in "What the live bundle shows", above): `APP_NAME:"proton-mail"`, `APP_VERSION:"5.0.140.12"`, `API_URL:"/api"`, `clientID:"web-mail"`, and the
same calls as the source (`auth/v4/sessions/local/key`, `core/v4/events/latest`, `` `core/v5/events/${e}` `` with
params, the `ps-` prefix and `resumeSession`'s ClientKey-then-blob order, `x-pm-uid`, `x-pm-locale`,
`application/vnd.protonmail.v1+json`, `mail/v4/messages/send/direct`, `core/v4/keys/all`). Its CSP allows `connect-src
'self'`, which is where the calls go. So `x-pm-appversion` is `web-mail@5.0.140.12` today; the hook copies whatever the
app sends, so a new release changes it by itself.

From ProtonMail/go-proton-api (MIT; Proton's Go client, used by Bridge): `RefreshMail = 1`, `RefreshAll = 255`
(`event_types.go`); its fake server answers 400 for an event id it does not know (`server/events.go`); the label
action's per-message `Responses[].Response.Code` (`message_types.go`); 150 per page (`paging.go`); and that an update
event's `Message` carries the message's metadata (Bridge reads `LabelIDs`, `Unread` from it).

## Operations

Ids (`src/mail.ts`), opaque to apps:

| | |
|---|---|
| mailbox | Proton's label id: `0` Inbox, `8` Drafts, `12` Scheduled, `7` Sent, `10` Starred, `6` Archive, `4` Spam, `3` Trash, `5` All mail, `16` Snoozed, or a custom folder's id |
| message | Proton's message id; a move keeps it (Proton moves by relabelling) |
| attachment | Proton's attachment id; `mime.<n>` for the n-th part inside a PGP/MIME body |
| `mail.list`'s `next` | `<Time>.<message id>`: the anchor of the next page |
| state | `e.<event id>`: a position in Proton's event loop, one for the whole account |

- `mail.mailboxes`: the system folders above with roles (`inbox`, `drafts`, `sent`, `flagged`, `archive`, `junk`,
  `trash`, `all`; Scheduled and Snoozed have none), then custom folders (`core/v4/labels?Type=3`) with their `Path`
  and parent; counts from `mail/v4/messages/count`. Proton **labels** (`Type=1`) are not mailboxes: their names are in
  each message's `labels`.
- `mail.list`: `GET mail/v4/messages?LabelID=…&Sort=Time&Desc=1`, the first page by `Page`/`PageSize`/`Limit`, the
  next by `Anchor`/`AnchorID`, as the web app. 50 by default, at most 500 (in requests of up to 200). `since` is
  `Begin` (seconds), checked to the millisecond here. Its summaries have `inReplyTo: null`, `references: []` and no
  `bulk` (below).
- `mail.get`: `GET mail/v4/messages/<id>` (it does not mark the message read; the web app marks read with a call of
  its own), the body decrypted: `text/html` gives `html` and text made from it, `text/plain` gives `text`,
  `multipart/mixed` is parsed (mailparser) for its text, HTML and parts. `messageId` is `<ExternalID>`, `threadId` the
  ConversationID, `inReplyTo`, `references` (all of them) and `bulk` from `ParsedHeaders` (below), `date` and
  `receivedAt` both Proton's `Time`
  (Proton gives no other), `preview` null, flags: `seen` = not `Unread`, `flagged` = in Starred, `answered` =
  `IsReplied`/`IsRepliedAll` or the replied flags, `draft` = in Drafts.
- `mail.attachment`: `GET mail/v4/attachments/<id>` (bytes) with the message's `KeyPackets`, decrypted; a `mime.<n>`
  part from the decrypted body. Over 25 MB is 413, checked before downloading from the size Proton gives.
- `mail.search`: **Proton's server search**: `GET mail/v4/messages?Keyword=<query>` in the mailbox, or without one in
  "almost all mail" (`15`: everything but Spam and Trash). Proton searches what its servers can read: the subject and
  the senders' and recipients' names and addresses. **Bodies are encrypted on Proton's servers, so no body text is
  searched.** Proton's own "search message content" builds an index in your browser; this does not.
- `mail.changes`: without a state, `core/v4/events/latest` as the starting point. With one, every event page from it
  (`core/v5/events/<id>`, while `More`, at most 50 pages), folded per message: created or gained the mailbox → `added`
  (with its summary), still in it → `changed` (flags and labels), lost it → `removed`, deleted → `removed` (Proton does
  not say where a deleted message was, so `removed` may name ids that were never in that mailbox: ignore unknown
  ones). An update that does not say where the message is now is answered by fetching the message. `limit` (default
  200, at most 1000) stops reading further pages once that many are added and says `more`; one page of events may
  give a few more. **410** when Proton says `Refresh` (mail) or refuses the event id (4xx): list the mailbox again.
- `mail.flag`: `seen` → `PUT mail/v4/messages/read|unread`, `flagged` → label or unlabel Starred (`10`). `answered`
  is refused with **501**: Proton sets it itself when you reply from Proton. Ids Proton refuses: 404 (not found) or
  422 with its codes.
- `mail.move`: `PUT mail/v4/messages/label` with the folder (a folder replaces the message's folder). Into Inbox,
  Archive, Spam, Trash, a custom folder, or Sent/Drafts (Proton refuses those for messages that are not sent mail or
  drafts). Views (All mail, Starred, Scheduled, Snoozed) are 400. The same ids back, `null` where Proton refused one.
- `mail.trash`: to Trash; messages already in Trash are deleted outright (`PUT mail/v4/messages/delete`), as the imap
  kind does.
- `mail.send`: through the page, the safe subset ("Sending"). Checked here first: `from` (one of `self.addresses`,
  matched without regard to case, else **422** with code `from` before the page is asked; it picks the address and so
  its keys, over a reply's own address), `to`/`cc`/`bcc` are
  `{ name, email }` lists (at least one recipient, at most 100), `subject` a string, `text` or `html` or both (with
  `html` the message is HTML, and Proton makes the plain text from it where someone needs plain text), `replyTo` a
  message id of this account, attachments `{ filename, mime, base64 | path }` (a path absolute, a regular file, not one
  of the account's own files), at most 25 MB together (Proton's limit): 400, 404, 403 or 413. Answers `{ messageId:
  <the Message-ID Proton gave>, sentId: <its id> }`; the sent message is the copy in Sent. A message it will not send as
  it stands is **422** with code `recipients` or `settings` and a sentence for a person ("Sending").

### Threading and bulk headers: which calls carry them

A summary's `inReplyTo`, `references` and `bulk` come from `ParsedHeaders` (Proton's parse of the message's headers:
`In-Reply-To`, `References`, `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`, matched without regard to
case; the first value where Proton gives a list). Only one call carries `ParsedHeaders`:

| call | carries `ParsedHeaders` | so |
|---|---|---|
| `GET mail/v4/messages/<id>` (a whole message) | yes | `mail.get` has `inReplyTo`, every reference and `bulk`; so does a summary made from it (mail.changes fetches a message when an event does not say where it is, and keeps 20 references there) |
| `GET mail/v4/messages` (mail.list, mail.search) | no: `MessageMetadata` | `inReplyTo: null`, `references: []`, no `bulk` |
| `core/v5/events/<id>` (mail.changes, mail.arrived) | no: the message's metadata | the same |

So no body is fetched for them: an app that wants them for a list fetches the message (`mail.get`), and threads by
`threadId` (Proton's ConversationID) meanwhile. The metadata does carry Proton's own sorting, passed on as labels
with Gmail's spelling: its categories (system label ids 20 Social, 21 Promotions, 22 Updates, 25 Newsletters,
26 Transactions, in `LabelIDs` and `CategoryID`; 24 is Primary, no label) become `Category/Social` and so on, and a
`NewsletterSubscriptionID` (a newsletter you subscribe to) makes `Category/Newsletters`. The status says
`details.summaryHeaders: false`. `UnsubscribeMethods` (Proton's parse of List-Unsubscribe) is on the whole message
only, beside `ParsedHeaders`. Values are kept raw: unfolded, spaces
made one, trimmed, at most 300 characters; `bulk` is there only when one of its four headers is. Message-IDs keep their
brackets, as `messageId` (`<ExternalID>`).

Events: `hello` (once per start), `status` (below), `mail.arrived { message }` for new mail in the inbox (created in
an event, not a draft or something you sent), `mail.changed { mailboxId, state }` for every mailbox an event touches
(its messages' labels, gained and lost, and the counts it updates). The extractor reads the event loop every 30 s
(`pollSeconds`), and right after each of its own writes. Where it got to is kept in `events.json` (an event id, 0600),
so after a restart it announces what came meanwhile (the newest 20, as the imap kind). When Proton asks for a refresh
it starts again from the latest event and says every mailbox changed, so apps ask, get 410 and list again.

## Status

Layers, outermost first: **display → browser → extension → signed in → keys unlocked → Proton API → app modules →
send path**.

- **keys unlocked**: which way the keys opened (above).
- **app modules**: "found CryptoProxy, AppApi, Store, AddressKeysByUsage"; while the page loads, "looking; not found yet:
  …"; after the grace time (90 s, `modulesGraceSeconds`), failed with what is missing ("the hook never reached the app's
  webpack" when not even the runtime was found: the chunk global was renamed).
- **send path**: "the page's API caller, store, crypto proxy and address keys found; mail.send sends to Proton users and
  to outside addresses without a key, and refuses the rest", or after the grace time failed with "not found in the
  page: …; mail.send refuses". It needs what the app modules layer needs and says what sending does with them; it is
  the last layer because only sending stands on it: an account whose send path is missing still reads.

Telling what broke from the status: the first layer that is not ok is where it stops; then `details`: `modules` and
`modulesMissing` (names), `webpack` (runtimes, modules installed, modules run: 0 runtimes means the probe never ran,
modules run but nothing found means the shapes changed), `sendPath`, `unlockPath`, `sessionUnlockError`, `pageKeys`,
`sent` (how many this run sent).

- **attention `login`**: "Sign in to Proton in the live view (tick "Keep me signed in")": the tab is on
  account.proton.me (or verify.proton.me), or the Mail page has no session; or "Proton signed this browser out…" when
  a call is still 401 after the page had its chance to refresh.
- **attention `keys`**: signed in, but the key password did not open the keys (the message says which step: the blob,
  the primary user key, an organisation-managed account).
- **attention `unknown`**: the extension did not attach within 30 s, or Proton Mail is no longer open after a sign-in.
- **error**: the sandbox could not start.
- **online**: signed in and the keys open. The Proton API layer shows the last call (ok, or what Proton said) and
  whether the event loop is being followed.

`self` is `{ email, displayName, addresses }`: the first enabled address, and every address it sends as
(`[{ email, name }]`: enabled, `Status` 1, and allowed to send, `Send` 1, in Proton's `Order`; `name` is the
address's display name, or null), read with the keys at unlock and again when an event says the addresses changed.
`details.canSend` is true when it is signed in and the app modules were found (the send path layer ok); it does not
promise that every message goes (some are refused: "Sending"). `details.sendNote` says why not to a person: "Mail cannot
be sent: Proton is not signed in. …", "Sending is not checked yet: …" while the page loads, and "Mail cannot be sent
from this account: parts of Proton's Mail page that sending uses were not found (CryptoProxy), so sending is refused.
Reading, marking, moving and trash still work." when one is missing; null when it can. `details` (none of it secret): `email`, `display`,
`page`, `extensionAttached`, `mailPage`, `signedIn`, `localID`, `keptSignedIn`, `sessionPayload`,
`sessionsInBrowser`, `canSend`, `sendNote`, `appVersion` (as the page sends it), `pageHeaders` (the names of the headers the app's calls
carry), `pageCalls`, `pageLastStatus`, `pageRefreshes`, `uidMatchesPage`, `userKeys`, `addresses`, `addressKeys`
(opened of all), `unlockPath`, `sessionUnlockError`, `pageKeys`, `modules`, `modulesMissing`, `webpack`, `sendPath`,
`sent`, `lastCallAt`, `lastCallStatus`, `lastError`, `calls`, `events`, `pollSeconds`.

Config (all optional): `pollSeconds` (30), `modulesGraceSeconds` (90), `noSandbox`. `testOrigin` is for tests: the
start page, the extension's matches and the Mail origin become it.

What it keeps in the account's directory: `profile/` (Chromium's, with the sign-in), `extension/` (re-copied each
start, its `config.json` holds the bridge token, 0600), `events.json`, `adapter.log`. Nothing from your mail, no key.

## Sending

`mail.send` (`src/send.ts`, the hook's `send`) sends the **safe subset** of what the web app's composer sends
(`useSendVerifications` and `useSendMessage` in WebClients): only the cases whose outcome is unambiguous, built by our own
code in Proton's own formats, and a refusal for everything else **before anything is made on the server**. Proton's
composer functions are not used (the live build does not expose them: "What the live bundle shows"). What it stands on
in the page: the app's API caller (AppApi), its store, its crypto proxy, and its choice of an address's keys.

What is sent:

- **To a Proton user** (or one of your own addresses): package type 1 (`SEND_PM`), encrypted to their key, signed by
  your address key. Their key is the one Proton would pick: for your own addresses, that address's primary key (as
  Proton's own, it asks the API nothing); for anyone else, `core/v4/keys/all`'s `Address.Keys`, those meant for mail
  (no `EMAIL_NO_ENCRYPT` flag), sorted as Proton sorts them (compromised, then obsolete, then not primary, then not v6
  go last); the first must be neither compromised nor obsolete and able to encrypt (the crypto proxy's `canKeyEncrypt`).
- **To an outside address with no key anywhere** (`RecipientType` 2, nothing in `Address`, `Unverified` or
  `CatchAll`): package type 4 (`SEND_CLEAR`): Proton's servers get the session key and send it on in the clear, as the
  composer does for them.

What is refused (422, nothing made; recipients are numbered from 1 in to, then cc, then bcc order, each address once,
and never named by address). Code **`recipients`**, one sentence per kind of problem, in recipient order:

| case | sentence |
|---|---|
| in your Proton contacts with encryption settings: a contact email Proton marks as having settings of its own (`Defaults` not 1), or a `KEY`, `X-PM-ENCRYPT`, `X-PM-ENCRYPT-UNTRUSTED`, `X-PM-SIGN`, `X-PM-SCHEME` or `X-PM-MIMETYPE` anywhere in the contact's signed or clear card | "Recipient N has encryption settings or a pinned key in your Proton contacts, so send this one from Proton." |
| an outside address with a key: published (WKD/KOO, in `Unverified` with an outside `Source`), or in `Address.Keys` with `RecipientType` 2 | "Recipient N publishes an encryption key, so Proton would encrypt to it; send this one from Proton." |
| the lookup failed (any error, Proton's codes included), Proton's `Warnings`, Proton-sourced `Unverified` keys or a catch-all key with no `Address.Keys`, an answer in another shape, a contact card that will not read or a contacts search that fails | "Proton couldn't confirm how to send to recipient N (its key lookup failed: …), so send this one from Proton." (the reason in brackets: "Proton warns: …", "Proton has only unverified keys for it", "it is a catch-all address", "their contact card could not be read", …) |
| a Proton address with no key it can encrypt to: none for mail (E2EE disabled, which Proton would send to in the clear), the first one compromised, obsolete or unable to encrypt, `RecipientType` 1 with no key | "Proton gave no key it can encrypt to for recipient N, so send this one from Proton." |

Several recipients with the same problem share a sentence ("Recipients 2 and 4 publish encryption keys, so Proton would
encrypt to them; send this one from Proton."). Code **`settings`**: "Your Proton settings sign mail to outside addresses
or attach your public key, which dither-chat can't do yet, so send this one from Proton." when someone would get it in
the clear and your mail settings have `Sign` or `AttachPublicKey` on (Proton would sign it as PGP/MIME or inline, or
attach your key), or when the message is HTML and `Sign` is on with `PGPScheme` PGP/Inline (Proton would then send
everyone the plain-text version). The settings are the page store's and the server's (`mail/v4/settings`), either one's
"on" counts. Recipient problems are told first. Code **`from`**: `from` is not one of the addresses the account sends
as (here or in the page).

Contacts are read as Proton reads them (the store's contact emails, then `contacts/v4/contacts/emails?Email=`; the
contact's cards from `contacts/v4/contacts/<id>`), but more warily: every matching contact, not only the first, and the
clear card as well as the signed one. The signed card's signature is not checked: a contact with settings of its own
(`Defaults` not 1, where Proton would check it) is refused anyway, and one without is used by Proton without a check.

**Key transparency is not checked.** Proton's web app checks a Proton recipient's key against its key transparency log
when KT is on for your account; this trusts `core/v4/keys/all`, as Proton's apps did before KT. Pinned keys in your
contacts are not used either: a contact that has them is refused.

The steps, in the page:

1. **Before anything is made**: each recipient (above), then your settings. Any problem refuses the whole message.
2. **The draft**: `POST mail/v4/messages` through the app's API caller, its body encrypted with your address's
   encryption key and signed with its signing keys (the app's `getAddressKeysByUsageThunk` picks them, as the
   composer's `useGetMessageKeys`), `ParentID` and `Action: 0` for a reply (so Proton threads it, sets In-Reply-To and
   References, and marks the original answered). Then each file: its own session key, encrypted with it and a detached
   signature (CryptoProxy, as `encryptAttachment`), the key to your key, `POST mail/v4/attachments` as a form
   (`Filename`, `MessageID`, `MIMEType`, `KeyPackets`, `DataPacket`, `Signature`).
3. **The package**: one, for the message's own MIME type (`text/html` when `html` is given, else `text/plain`; with no
   contact or setting saying otherwise this is the type Proton gives every recipient), `Flags` the draft's with
   `FLAG_RECEIVED`, every recipient in it: `{ Type: 1, Signature }` (1 when every file is signed, which ours are) for a
   Proton user, `{ Type: 4, Signature: 0 }` for a clear one, the package's `Type` their OR. As `encryptDraftBodyPackage`:
   one session key made for your key and theirs, the body encrypted under it and signed with your address keys, the
   key encrypted to each Proton recipient's key (`BodyKeyPacket`); each file's session key likewise
   (`AttachmentKeyPackets`); when the type has 4, `BodyKey` and `AttachmentKeys` (`{ Key, Algorithm }`) in the clear.
   Then **checked against the decisions**: one package, each recipient once with the type decided, a key packet for
   the body and every file for each Proton recipient and none for a clear one, the clear keys exactly when someone is in
   the clear. Anything else is refused (500) and the draft deleted.
4. **The send**: the form as `sendFormatter` makes it (`Packages[<mime>][…]`, bytes as blobs, `AutoSaveContacts` and,
   when set, `DelaySeconds` from your settings, no `ExpiresIn`), `POST mail/v4/messages/<draft id>` through the app's
   API caller. Proton files the sent message in Sent; its id is `sentId`, its Message-ID (`ExternalID`) `messageId`.

If Proton refuses the draft, a file or the send, the draft is deleted (`PUT mail/v4/messages/delete`) and the error
passed on with Proton's status. If the page does not answer in time, 504 says it may or may not have gone: look in Sent.
When the page's modules are missing, `mail.send` is 501 ("the Mail page's CryptoProxy was not found, so nothing was
sent") and `details.canSend` is false. Logs say counts only: recipients, how many encrypted and in the clear, files, the
package type; a refusal's sentence (no addresses in it).

**Where it stands**: the fake's page (as live, without the composer's functions) and every test send through it, and
the fake checks each send as a server holding every recipient's key would ("Tests"). Nothing has been sent from a real
account yet: your first send is the checklist's step 9.

## Tests

- `test/proton.test.ts`: no browser. The blob in all three versions (and a wrong key, version or a damaged blob), the
  key chain (token and signature, a forged signature, a legacy address key opened with the key password, a wrong key
  password), and every op against the fake through a transport that calls it straight: mailboxes, list paging and
  `since`, get (HTML, plain, PGP/MIME, a message to the second address), attachments (and 413), search, changes
  (added, changed, removed, deleted, a bare update, labels by name, `more`, 410 on refresh and on a forgotten id),
  flag (and 501), move (null ids, views refused, a new folder), trash (and outright), unlocking again, retries and
  logged reasons, nothing secret in the log. And `mail.send`'s side here: the message's checks (addresses, body, files,
  paths, the 25 MB cap), the page's answers (refused with its status, sent, anything else 502), a reply from the
  original's address, the Message-ID fetched when the send did not give it, a timeout as 504, a refusal's code
  (`from`, `recipients`, `settings`, only with 422) carried to the app's error. Threading and bulk
  headers from `ParsedHeaders` on `mail.get` (all references, a folded List-Id, the first of two List-Unsubscribe) and
  on a summary made from a whole message (20 references), none on `mail.list`; the sending addresses of a fake with
  five (one disabled, one that only receives, out of order); `from` picked without regard to case, sent to the page as
  its id over a reply's, refused (422 `from`, the page never asked) when not one of them.
- `test/proton-browser.test.ts`: a real manager runs the extractor in its real sandbox against the fake (four that
  stay: signed in; signed out; the saved session broken; the ClientKey call refused, as live; and two that come and
  go, whose page hides the CryptoProxy or the keys-by-usage thunk). Online with every layer ok, self, details (the four
  modules found, one runtime), the live view's VNC; every op through `AccountsClient`; mail.arrived and mail.changed
  from the event loop; 410. **Sending**, every send checked by the fake with the recipients' keys and opened again by
  the test: to Proton users only (a contact without settings, yourself, someone whose primary key is listed after
  another): type 1 each, signature flag 1, each body opening with that recipient's key (the primary one) and not
  another's, no key in the clear; to an outside address with no key: type 4, the clear key opening the body; both at
  once with a file (one package of type 5; each Proton recipient's key opens the body and the file, the clear keys
  open both; the draft's copy opens with your key; nothing readable as it stands; the copy in Sent); a reply
  (`ParentID`, `Action` 0, the original answered). **Refusals**, each 422 `recipients` with its exact sentence and
  nothing made: a contact with `KEY`, with each `X-PM-*` property, with one in its clear card, with `Defaults` 0, one
  whose card will not read; WKD keys; keys in `Address.Keys` for an outside address; a failed lookup; `Unverified`
  keys; `Warnings`; a catch-all key; a Proton address whose key is for no mail, obsolete, or missing; seven recipients
  with four kinds of problem in one message, as four sentences; bad input 400. **Settings**: `Sign` with someone in
  the clear, `Sign` with PGP/Inline for an HTML message to a Proton user, and `AttachPublicKey`: 422 `settings`;
  `Sign` with Proton users alone sends; a recipient problem is told first. **`from`**: the alias picked (the draft's
  address and sender are the alias's, the friend's key opens it), over a reply's address, and an address not its own
  refused (422 `from`) making nothing. `self.addresses`; `canSend` true on every signed-in account (none of them has
  the composer's functions), false with its note when signed out or when the CryptoProxy or the keys-by-usage thunk
  is missing (then the app modules and send path layers name it, and mail.send is 501, making nothing, while reading
  works); **the unlock fallback**: keys through the page's crypto proxy, bodies and files read through it, and sends
  from it (both page-key accounts); an access token that runs out (the page refreshes it, never the hook); every call
  of ours carrying exactly the app's headers; a signed-out browser asking for the sign-in; Proton signing the browser
  out; nothing secret, and no recipient address, in logs or statuses; every process gone when the manager stops.
  Skipped without Xvfb, chromium and x11vnc.
- `test/fake-proton.ts`: the fake. Its page keeps what the real app keeps (`ps-0` with a blob sealed under a ClientKey,
  the `AUTH-<UID>` and `REFRESH-<UID>` cookies), calls the API itself with the app's headers (and a marker header, so
  the fake can tell its calls from the hook's), polls events and refreshes on 401. The API checks the cookie for the
  `x-pm-uid`, the app version and the accept header. Keys are real OpenPGP keys made at start. Its page runs
  `test/fake-proton-app.js` and `test/fake-proton-main.js`: a webpack runtime and chunks shaped as the live bundle's (one
  runtime on `webpackChunkproton_mail`, no module cache, array-form exports, a lazily loaded main chunk), with a
  CryptoProxy over openpgp (with `canKeyEncrypt`, and keys that say their version), the thunk argument, a store on a
  React-shaped `.app-root` (with the mail settings and the addresses' key metadata), keys by usage (`withhold` hides
  the CryptoProxy or the keys by usage one level down), and a main chunk that exports only its component, as live. As
  Proton's, only a whole message has
  `ParsedHeaders` (its Message-Id and whatever `deliver` was given, a list where a header is there twice); lists and
  events carry the metadata alone. `moreAddresses` adds three addresses without keys: disabled, receive-only, and one
  more that sends. `recipient()` sets how `GET core/v4/keys/all` answers for an address (a Proton user, one with two
  keys, one whose key is for no mail, obsolete or missing, an outside address with none, with a WKD key, with a key in
  `Address.Keys`, `Unverified` or catch-all keys, `Warnings`, an error), `contact()` puts one in your contacts (its
  properties, card type, `Defaults`, or unreadable), `setMailSettings()` changes `mail/v4/settings`. **The send is
  checked** as a server holding every key would: each Proton recipient's (or your own address's) body key packet opens
  with their key, the body it opens is the draft's text signed by the sender's address key, each attachment key packet
  opens the uploaded file (whose detached signature verifies); the clear body and attachment keys open the same; each
  address's `Type` and `Signature`, the package's `Type` (their OR), `Flags`, MIME type and clear keys; every recipient
  once. A wrong one is refused (422) and kept in `rejected`; a right one is kept in `sent` with what was checked
  (`verified`). `brokenSession` closes the saved-session way in.
- `scripts/verify-proton.ts`: the whole kind through a throwaway manager's main.ts on a temp directory (port 18565)
  against the fake: added through `POST /api/accounts`, online, every op through an approved app, events, sending (a
  Proton user and an outside address with a file, checked by the fake and opened with the recipients' keys; a WKD
  recipient refused `recipients` and `Sign` refused `settings`, each making nothing; `from` the alias, and a stranger
  refused `from`), headers on `mail.get` and none on `mail.list`, `canSend` and `self.addresses`, the token refresh,
  the page's "Try it", a second, live-like account (keys through the page, no composer functions: canSend true, and it
  sends), nothing secret, no header value or recipient's address said, every process gone after.

## What a fake cannot settle

Nobody has signed in to a real Proton account for this (the work was done without one). Inferred from the source and
the live bundle, but not seen live:

- **the persisted session in a real profile**: that `ps-<n>` holds a v3 blob for a session made through
  account.proton.me's fork, and that `auth/v4/sessions/local/key` answers the hook's call (the web app makes the same
  call with the same headers when it resumes);
- **the headers**: that copying `accept`, `x-pm-appversion` and `x-pm-locale` from the app's calls (plus `x-pm-uid`) is
  all Proton wants; if the app adds a header Proton checks, `pageHeaders` in the details lists its name;
- **the event loop's edges**: what Proton answers for an event id it has forgotten (go-proton-api's fake says 400;
  any 4xx is taken as 410 here), and whether an update event always carries `LabelIDs` (if not, the message is
  fetched, which is slower but right);
- **paging by anchor**: that `Anchor`/`AnchorID` with `Sort=Time&Desc=1` gives the messages after the anchor (as the
  app uses it);
- **search**: what `Keyword` matches exactly on the server;
- **keys this does not open**: organisation-managed (non-private) members' keys (refused with a message), Proton's
  E2EE-forwarding keys (Proton's openpgp fork has an option for forwarded messages that upstream openpgp lacks: mail
  auto-forwarded to you that way may not open), and any post-quantum keys Proton may roll out;
- **the 401 dance**: that the app's own refresh after a 401 always comes within 45 s (its event loop polls every
  30 s or so in the foreground).
- **the app modules signed in**: that the store is on `.app-root`'s React tree with the thunk argument it should hand
  out, that the thunk argument is filled with `api` and `authentication`, and that `getAddressKeysByUsageThunk` on it
  gives the keys the page decrypts with (the page-side unlock has only met the fake's store);
- **sending against real Proton**: never done. The draft, upload and send requests follow WebClients' `createDraft`,
  `uploadAttachment` and `sendMessageForm` and the composer's order, and the packages its `sendTopPackages`,
  `sendSubPackages`, `sendEncrypt` and `sendFormatter` for types 1 and 4; only the real server says it takes them.
  Also only live: that `core/v4/keys/all` still carries `RecipientType` (Proton's current client does not read it; a
  missing one is inferred as Proton does, from `Address.Keys`), whether a Proton user's answer carries `Unverified` keys
  beside `Address.Keys` (Proton then uses `Address.Keys` and ignores them, and so does this: unverified and catch-all
  keys refuse only when `Address.Keys` is empty, as getPublicKeysEmailHelperWithKT reads them), what Proton's API answers for an
  address that does not exist (refused here as a failed lookup), that the real crypto proxy's keys have `getVersion`
  and `canKeyEncrypt` (without them every Proton recipient is refused: "this page cannot check keys"), that the
  store's mail settings and contact emails sit where this reads them (`mailSettings.value`,
  `mailContacts.contactsMap`, `contactEmails.value`; the API is asked too), and how your real contacts' cards and
  `Defaults` look (a contact you never gave settings to should be `Defaults` 1 and send; one that is refused says so
  in plain words).

## Your real-account checklist

1. Add the account: accounts page → **Add → Proton Mail**. It says "Sign in to Proton in the live view". Once
   online, the status's `self.addresses` lists the addresses you can send from in Proton (Settings → Identity and
   addresses), disabled ones left out.
2. Open **Live view**. The browser shows Proton's sign-in (account.proton.me). Sign in: password, second factor, any
   check Proton asks for. Tick **Keep me signed in**. Wait for your inbox.
3. On the account's overview, the layers should all be green within a minute:
   - **signed in**: your address, with no "not kept" warning (if there is one, sign out in the live view and sign in
     again with "Keep me signed in");
   - **keys unlocked**: "N of N address keys on M addresses" (all of them);
   - **Proton API**: "answered 200 …; following events".
   If it stops at **keys unlocked**, its note says which step failed; the `keys did not unlock` line in the log too.
4. In **details**, check: `appVersion` is `web-mail@5.0.…`, `keptSignedIn` true, `sessionPayload` 3, `uidMatchesPage`
   true, `canSend` true (as the send path layer says; if false, `sendNote` says why), `pageHeaders` (note anything besides `accept x-pm-appversion x-pm-locale x-pm-uid` and content-type: a new
   header Proton may want), `lastError` empty.
5. **Try it** on the page, in this order:
   - `mail.mailboxes`: your folders with counts that match the web app's sidebar;
   - `mail.list { mailboxId: "0", limit: 5 }`, then again with `before` set to the `next` it gave: the next five, no
     repeats, no gaps (compare with the web app);
   - `mail.get` on one of them: the text and HTML are your message's, not ciphertext; an older message too, and one
     from a Proton sender and one from an outside sender; on a newsletter, `bulk` has its List-Id and
     List-Unsubscribe, and on a reply `inReplyTo` and `references` are filled (if they are null on a message whose
     headers in the web app show them, Proton's `ParsedHeaders` names them otherwise: note how);
   - `mail.attachment` on a message with a file: the bytes (the page shows the size; download it from the web app and
     compare if you like);
   - `mail.search { query: "<a word from a subject>" }`: the message;
   - `mail.changes { mailboxId: "0" }` gives a state; send yourself a mail from elsewhere; within 30 s the account's
     log says `events: … arrived`, and `mail.changes` from that state lists it in `added`;
   - `mail.flag { ids: [id], seen: true }` and back to `seen: false`: the web app shows it read, then unread;
   - `mail.move` it to Archive and back to Inbox (`0`); `mail.trash` something you do not need.
6. Leave it a day, then check it is still online without a new sign-in (the session and the cookie refresh held). In
   the log, `api: 401; waiting for the page to refresh its session` followed by working calls is fine; `Proton
   answered 401 after the page had its chance to refresh` means it was signed out.
7. Restart the account (Stop, Start): it comes back online without a sign-in (the profile kept it), and announces mail
   that came while it was stopped.
8. **The hook.** Within a minute of the inbox loading, the **app modules** layer says "found CryptoProxy, AppApi, Store,
   AddressKeysByUsage" and `details.webpack` says "1 runtime, … modules, … ran". If it stays "not found", note which
   names `modulesMissing` lists and the `webpack` counts (0 runtimes: the chunk global was renamed; modules ran but none
   found: the shapes moved): that is what to fix in `hook.js`.
9. **The send path.** The **send path** layer says "the page's API caller, store, crypto proxy and address keys found;
   mail.send sends to Proton users and to outside addresses without a key, and refuses the rest", and `canSend` is true.
   - The first real send goes **to your own address**:
     `mail.send { to: [{ name: null, email: "<your own address>" }], subject: "dither test 1", text: "hello from dither" }`.
     It answers `{ messageId: "<…>", sentId: "…" }`. In the web app: the message is in Sent and in your Inbox, it
     reads "hello from dither", and its lock icon says end-to-end encrypted (and the signature verifies). Then
     `mail.list { mailboxId: "7", limit: 1 }` gives `sentId`. If instead it answers a 422, its sentence says which
     check refused (for plain text to your own address only "Proton gave no key it can encrypt to" can): report
     that sentence in an issue.
     A 500 "the packages did not come out right" or a Proton error from the send means the format met something this
     did not expect: the draft was deleted; report the message in an issue (it holds no content).
   - Then the same with `html` and a small file (`attachments: [{ filename: "a.txt", mime: "text/plain", base64:
     "aGk=" }]`): the file opens in the web app. Then a reply: `replyTo` set to the id of a message in your inbox, sent
     to yourself: the web app threads it under the original, and the original shows as answered.
   - Then a Proton user you know (a second account of yours is best): it arrives, encrypted, signed by you.
   - Only then an outside address of yours with no PGP key: it arrives in the clear (as Proton's composer would send
     it), and Proton's Sent copy says so. If your settings sign outside mail or attach your key, it is refused
     (`settings`) instead, as it should be. The log line `send: N recipient(s), K encrypted, M in the clear, …` should
     match what the web app shows.
   - A refusal to look at: an address in your contacts that you gave a pinned key or encryption settings is refused
     (`recipients`, "has encryption settings or a pinned key in your Proton contacts") with nothing in Drafts.
10. **The page-side unlock** (only if you want to see it work on the real page; it is the fallback, not the usual way):
   it shows only when the saved-session unlock fails. With a working account `details.unlockPath` is `session`. If
   one day the keys layer says "through the page's crypto proxy …", read `sessionUnlockError` (what moved), check that
   `mail.get` still shows text, and report the reason in an issue so the first way in can be fixed.

If anything is off, the account's `adapter.log` has each refusal as `<METHOD> <path>: <status> code <Proton's code>
(<Proton's reason>)`: that line is what to look at first.
