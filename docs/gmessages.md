# Google Messages (kind `gmessages`)

Your texts — SMS, MMS and RCS — through Google Messages on your Android phone, the way messages.google.com does it.
The account implements the `chat` interface, so dither-chat's hub (or any app with a `chat` grant) reads and sends
them like any other chat network.

```
app ─ manager ─▶ extractors/gmessages (TypeScript, the chat adapter)
                        │ JSON lines on stdin/stdout
                        ▼
                 bridge/ (Go, libgm from mautrix-gmessages)
                        │ HTTPS long-poll, end-to-end encrypted to the phone
                        ▼
          Google's relay (instantmessaging-pa.googleapis.com) ─▶ your phone ─▶ SMS / MMS / RCS
```

**Every message goes through the phone.** Google's servers only relay between this session and the phone; nothing is
sent or received while the phone is off, offline, or has Google Messages killed by battery saving. That is why the
status has a `phone` layer and why a silent phone is shown as needing you.

## Pairing

There are two ways, and the account does whichever it has what it needs for.

1. **QR code** (the default; it is what the task asked for first). The status's attention carries the pairing URL as
   `qr`; the manager's page draws it, refreshed every 30 s (six codes, then *New code*). On the phone: Google Messages
   → your profile picture → **Device pairing** → **QR code scanner**.

   **Google has been retiring QR pairing.** mautrix-gmessages turned it off in v26.05 (May 2026) because "Google has
   discontinued it". The code is generated the same way messages.google.com used to, but your phone may have no QR
   code scanner any more, or may refuse the code. The attention message says so and points to the second way.

2. **Google account** (how messages.google.com pairs now). The account needs the cookies of a browser signed in to
   messages.google.com with the Google account your phone's Google Messages is signed in to. With them, the bridge
   asks Google to pair, and the status shows an emoji (`attention.kind: 'verify'`, `detail.emoji`); tap the same emoji
   where Google Messages on the phone asks. The cookies can be given:
   - in the add form's optional **Google cookies** field (it goes to `secret.json`, never to the config or the page);
   - later with the action `pairGoogle { cookies }`, or `relogin { password: cookies }` — the page shows a box for
     the latter whenever the attention is `login` (it calls it "Password"; paste the cookies there).

   Any of these forms works: **Copy as cURL** of a request to messages.google.com from the browser's network tab, a
   cookie-export JSON list (`[{name, value, domain}]`), a JSON object, or a bare `SID=…; HSID=…` header. It needs
   `SID HSID SSID APISID SAPISID OSID` and keeps `__Secure-1PSIDTS` too; everything else is dropped.

   These cookies sign in to your whole Google account. They stay in `secret.json` (0600, written atomically) inside
   the session, where Google rotates them, and are sent only to messages.google.com and Google's Messages endpoints.

After pairing, the session (libgm's `AuthData`) is written to `secret.json` and the raw cookies field is dropped. A
restart connects with the stored session and pairs nothing.

## Status

`status` always carries `layers`, outermost first, and `details`; `self` once paired.

| layer | ok | waiting / failed |
|---|---|---|
| `bridge` | `libgm, pid N` | starting, restarting after a crash; failed when it cannot be built or run |
| `phone` | answered at HH:MM (battery, network when known); "it must stay on and online" | waiting before pairing and until it first answers; **failed** "not answering since …" |
| `paired` | by QR code / with a Google account (its email) | scan the QR code (n of 6), expired, tap 🦊, needs cookies; failed when Google pairing failed |
| `connected` | to Google's relay, the phone's active session | connecting, reconnecting (listen error); **failed** when another browser took the session |

Attention, by what happened:

- not paired: `link_device` with `qr` (or the emoji as `verify`, or `login` when cookies are needed)
- the phone stops answering (libgm's PhoneNotResponding: the phone is pinged every 20 minutes, as
  mautrix-gmessages does to spare its battery, and an unanswered ping is retried with doubling timeouts, so about
  15 minutes after it goes quiet): `attention`, message "Your phone is not answering…"; back to online as soon as it
  answers or anything arrives
- Google Messages opened in another browser (BROWSER_INACTIVE): `attention`; run `setActive` (or Reconnect)
- unpaired from the phone (removed under Device pairing), or Google forgot the pairing: the session leaves
  `secret.json` and a new QR code shows, saying why; a Google-account pairing whose cookies still work asks for a new
  emoji at once
- Google signs the cookies out (401): `login`, asking for fresh cookies

`details` (flat, never secret): `pairedVia`, `googleAccount`, `phoneNumber`, `carrier`, `sims`, `rcs`,
`readReceipts`, `typingIndicators`, `defaultSmsApp`, `messagesVersion`, `phoneResponding`, `phoneLastHeard`,
`activeHere`, `battery`, `network`, `conversations`, `messages`, `lastSync`, `tokenExpires`, `namespace`.

## What it stores

- `secret.json`: `session` (libgm's AuthData: the AES/HMAC keys shared with the phone, the refresh key, the Tachyon
  token and its expiry, the browser and phone device ids, and for a Google pairing the account's cookies), and
  `cookies` only between being given and pairing.
- `state.db` (bun:sqlite): per conversation its Google Messages id, its fact as last published, SMS or RCS, the SIM
  participant it sends from, end-to-end encrypted or not, read or not; per message its id, author, time, how far it
  got, a hash of its content (not the text), its reactions, and its media's ids and decryption keys (to download them
  later); the names and numbers of the people in your conversations, as the phone names them; the phone's settings
  (SIMs, RCS flags).
- `media/`: a download in flight, deleted as soon as it is read.
- `adapter.log`, `extractor.pid`, the bridge's nix build path (`gm-bridge.<hash>.path`).

## Ids

Google Messages numbers conversations and messages per phone, so they are namespaced by a hash of the paired phone:
conversations `<ns>:c<id>`, messages `<ns>:m<id>`, you `<ns>:me`. People are their phone number (`+15551234567`, so
the same person in two accounts is one identity), an email for RCS by email, `sender:<name>` for alphanumeric senders,
or `<ns>:p<participant>` when the phone gives nothing else. Pairing the same phone again keeps the namespace; another
phone (or switching between QR and Google pairing) gets a new one, so its conversations are new conversations.
Attachments are `gm-media:<message>/<index>` and contact pictures `gm-avatar:<participant>`, both through `fetchMedia`.

## What it does, and what Google Messages does not allow

Capabilities: `send history react redact markRead typing media sendMedia e2ee openDirect about profile`.

- **send**: text (dither-chat's Markdown becomes plain text: no formatting exists in SMS/RCS), files, and replies.
  Replies are RCS only: a reply in an SMS/MMS chat, or to an SMS, goes as a plain message. In SMS/MMS the text rides
  with the first attachment as its caption; RCS takes no captions, so the text follows the files. The reply carries the
  message id from the phone's copy of what was sent (it waits up to 15 s for it). In a chat that became end-to-end
  encrypted RCS, sends force RCS so nothing falls back to SMS.
- **react**: one reaction per person (`switch` replaces yours). In SMS/MMS chats the phone sends a reaction as a text
  message ("👍 to …"); `reactionContext` says so.
- **redact** deletes the message from the phone (and so from every paired device). Google Messages has **no unsend**:
  the other side keeps it.
- **markRead**, **typing** (RCS only; there is no "stopped typing" to send), **history** (older messages, paged from
  the phone with its cursor; the phone has to answer), **fetchMedia** (downloads and decrypts; for a preview-only
  picture it shows the preview and asks the phone for the full one), **openDirect** (any phone number; the phone makes
  or finds the conversation), **about** (a group's name and members; read-only), **profile** (name, number, contact or
  not: Messages has no profiles).
- Events: conversations (direct and group, archived; deleted, spam and blocked ones leave), identities, messages with
  media, subjects, replies and system messages ("Bob left"; protocol noise such as "group created" is dropped),
  reactions (a snapshot when first seen, then each change), deletes, read state (a chat read on the phone), receipts
  (delivered and read in 1:1 chats; in groups from "Read by Alice, Bob", matched by first name), typing (15 s).
- **Not possible**: editing (`edit` is refused), forwarding (`forward` answers a fallback, so the hub resends the
  content), renaming a group or any other setting (`configure` is refused; do it on the phone), calls, threads.
- An MMS the phone is still downloading by itself waits until it has it; one waiting for a manual download says so.
- On connect it lists the 25 most recent inbox conversations (`config.initialChats`) and fetches up to 20 messages for
  each one it has not seen (`config.initialMessages`); the first sync is history, later catch-ups are news. Archived
  and spam folders are not listed (an archived chat that gets a message arrives as an event).
- One web session at a time: opening messages.google.com in a browser takes the phone's attention away from this one.

## Actions (`action` op, manage level)

`startLink` / `refreshLink` (a new QR code, or a new emoji with stored cookies), `pairQr`, `pairGoogle { cookies }`,
`relogin { password }` (the page's box: cookies), `relink` (unpair on the phone and pair again), `logout`,
`reconnect` (a fresh bridge), `setActive` (take the session back from another browser), `resync`, `typing`, `status`.

## Config (all optional)

`pairing: 'google'` (ask for cookies instead of showing a QR code), `initialChats`, `initialMessages`, `debug`
(libgm's debug log to adapter.log), `proxy` (`http://`, `https://` or `socks5://host:port` for everything the bridge
sends to Google), `pingMinutes` (how often the phone is pinged; 20 by default, more often drains its battery),
`deviceName` (what the phone lists the pairing as under Device pairing; `dither-accounts`).

## The bridge, and its licence

`bridge/` is a separate Go program, `dither-gm-bridge`: it imports libgm (`go.mau.fi/mautrix-gmessages/pkg/libgm`,
v0.2610.0) and speaks JSON lines; `bridge/mapping.go` turns libgm's protobufs into plain JSON (Go tests in
`mapping_test.go`, `cookies_test.go`). The extractor builds it on first start with nix
(`bridge/package.nix`, pure Go, `CGO_ENABLED=0`, its tests run in the build), or runs `$GMESSAGES_BRIDGE_BIN` or
`dither-gm-bridge` from PATH.

libgm is **AGPL-3.0-or-later**, so the bridge is too: `bridge/LICENSE` is the AGPL's text and its sources say so. The
TypeScript extractor only exchanges JSON lines with it across a process boundary; it contains none of libgm's code.
mautrix-gmessages' `LICENSE.exceptions` are for Beeper and Element only and do not apply here. What that means if
dither-accounts is ever published:

- `bridge/` stays under the AGPL, with its LICENSE, and anyone who gets the bridge (as source or as a binary, a nix
  store path, a container) gets its complete source under the AGPL; a changed bridge must be published under it too.
- Running it for others over a network with changes (AGPL §13) means offering them the bridge's source; unchanged, the
  upstream source suffices.
- The rest of dither-accounts is a separate program talking to it over a pipe, and can carry its own licence, as long
  as no libgm-derived code moves into the TypeScript side. Say in the README that `extractors/gmessages/bridge` is
  AGPL-3.0-or-later.
- The bridge's other dependencies are permissive or weakly copyleft (zerolog MIT; go.mau.fi/util MPL-2.0;
  protobuf, uuid and golang.org/x BSD-3-Clause), all compatible with the AGPL.

## Tests

- `extractors/gmessages/test/adapter.test.ts`: the adapter on the fake bridge (`test/fake-bridge.ts`, driven over a
  Unix socket): both pairings, every op, every event, the phone going silent, unpairing, a Google sign-out, another
  browser, a crashed bridge, a failed connect, a restart keeping the session.
- `extractors/gmessages/test/real-bridge.test.ts`: the real bridge (built with Go from the local module cache) under
  the adapter, with every request sent to a proxy that refuses it, so nothing reaches Google. Skipped without Go.
- `cd extractors/gmessages/bridge && CGO_ENABLED=0 go test ./...`: the mapping, cookie parsing, the line protocol.
- `test/gmessages.test.ts`: through a manager, added as the page adds it, paired, used by an app, restarted, unpaired.
- `bun scripts/verify-gmessages.ts`: a throwaway manager on 18520 with the fake bridge, added through the HTTP API and
  driven as an app through every op and event.

## What only your phone can check

1. Add a Google Messages account on the page with no cookies. Does your phone still have Google Messages → Device
   pairing → **QR code scanner**, and does scanning the code pair it (the status goes online with your number)?
2. If not: sign in at messages.google.com in your browser with the Google account Google Messages on the phone uses,
   copy a request to `messages.google.com` as cURL, and paste it (relink first if needed: action `pairGoogle`, or the
   add form's cookies field). Does the phone ask you to tap an emoji, and does the one on the page match?
3. Do your conversations and their latest messages appear in the hub, with names from your contacts?
4. Send a text to yourself or a friend over SMS and over RCS; reply to an RCS message; send a picture. Does each arrive
   once, and does the hub get the message id?
5. React in an RCS chat and in an SMS chat (what does the SMS recipient see?), mark a chat read, type in an RCS chat
   (does the other side see "typing"?).
6. Put the phone in airplane mode for half an hour: does the account show "Your phone is not answering" (after about
   15 minutes, or at once when you send something), and recover when it is back? Does a message sent meanwhile go
   out later, or fail?
7. Open messages.google.com in a browser: does the account say Google Messages moved there, and does `setActive`
   bring it back?
8. Remove the pairing on the phone (Device pairing → the "dither-accounts" entry → forget; is it named so?): does the
   account say so and show a new code (or a new emoji with a Google pairing)?
9. Restart the account: does it come back online without pairing again? Leave it a day: does it stay paired (the
   token refreshes, `tokenExpires` moves on)?
