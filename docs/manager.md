# How the manager works

The details behind the [README](../README.md): the spec apps and extractors are written against, every part of the
manager's page, what an app that runs accounts may do, and where the code lives.

## The spec

An interface (`packages/interfaces`, written with `packages/spec`) is an effect signature: operations with typed input
and output, and the events it emits. Each operation has a level:

- **read**: observe (history, profiles, a calendar's events)
- **write**: act as you (send, react, edit, create an event)
- **manage**: change settings and membership as you, run account actions

An extractor is a handler for one or more interfaces on one account; a grant is an interface on some accounts up to a
level, which reads as consent lines ("Read your chats…", "Send … as you"). Schemas are small combinators checked at
runtime (`s.object({ calendarId: s.string })`) whose types the client infers, so
`acc.call(googleCalendar, account, 'calendar.events.list', { calendarId })` is checked at build time and at the
boundary.

The interfaces are in `packages/interfaces`; [Layout](#layout) lists them. `chat` is dither-chat's adapter protocol.

Calls pass through handlers, each able to answer or pass on: the grant check, input check, rate limits (per app,
account and level), call counts, and **dry run** (a grant whose writes are answered without reaching the account),
then the extractor. Events go to every app whose grant covers them; while an app is away they wait in memory,
bounded, and past the bound the app gets a `gap` and asks the account to start over. Only each account's latest
`hello` and `status` are kept (and who it was last signed in as, to name it while it is stopped), plus daily call
counts (never what was asked or answered).

A failed call says why in `CallError.code`: the manager's own words (`denied`, `limited`, `offline`, `timeout`,
`invalid`, `unknown-op`, `unknown-account`), `failed` when the extractor threw, and, when the extractor refused and
named its reason (`new StatusError(message, 422, 'recipients')` in packages/link), that word with the extractor's
`status`. The interface documents its words (Proton's `mail.send`: `from`, `recipients`, `settings`, in
packages/interfaces/src/mail.ts). An extractor cannot use one of the manager's words: those arrive as `failed`.
Three words mean the same wherever they come from (packages/spec `CallError`): `retry` (503), the call was never
sent and may be sent again (it waited for an extractor or a page being replaced, and its time ran out first);
`unsure` (504), a write that may or may not have happened; and `duplicate` (409).

It also says what kind of failure it is, in `CallError.kind` (spec `FailureKind`), so the app need not guess it from
the message: `expected` for a refusal that is the right answer (`denied`, `invalid`, `offline`, a 404), `transient`
for the world failing for a moment (`limited`, `timeout`, a 503; `retryAfterMs` says how long to wait when that is
known, as for `limited`), and `bug` for something that waiting will not fix. The extractor says it
(`new StatusError(message, 503, 'unavailable', { kind: 'transient', retryAfterMs })`); when it does not, the manager
fills it in from its own code, else the status (a 4xx other than 408 and 429, or a 501: expected; 408, 429, 503, 504:
transient). A 500, a 502 or a plain error stays without one: not known. The call's span carries the same `kind`, for
bugwatch. `transient` does not make a write safe to send again: `unsure` is transient too.

### A failed read is remembered (when the app asks for it)

An app that asks again on every poll, watch or page open, about something that failed, would ask the manager again
each time; the manager's trace and bugwatch would then count its loop, not how bad the failure is. With
`new AccountsClient({ ..., remember: true })` (spec `memory.ts`, `FailureMemory`), the client keeps the last failure
of each read, keyed by the account, the op and the input (its JSON with keys sorted), and answers a repeat from it
until it is due, without sending it: the same error, with `remembered` (when it failed, how many times in a row, how
many repeats since) and `retryAfterMs` the time left.

- **When it is due**: a `transient` failure after 5 s, doubling to 5 minutes, and never before its own `retryAfterMs`;
  a `bug` (or one of no known kind) after a minute, doubling to 30; an `expected` one after 10 minutes, or sooner when
  something relevant changes.
- **What clears it**: the same call answering; a write this client made to the account answering (it may change what
  the reads answer); the account's state changing (running, online, enabled, its error, its grants); `forget(account?,
  op?)`, for an app that knows better (a person asked to refresh). Another input is another call, asked at once (a new
  sync token).
- **What is never remembered**: writes, and failures the manager did not answer (the client's own timeout, a dropped
  socket, `unsure`).
- **Counted, not sent**: the call sent once it is due carries `repeats`, how many times it was answered from memory
  since it last failed, and the manager puts it on the call's span (`attrs.repeats`). Kept to 500 calls, the oldest
  failure dropped first.

It is off by default: an app turns it on when it treats a remembered answer as it would the failure.

### A call runs once

An app's client resends what it was waiting for when its socket drops and comes back (a deploy restarts the manager,
while the extractors keep running: docs/supervisor.md). So that a resend never makes a write go twice:

- **The manager** runs each call id of an app once (`REPEATS` in router.ts: 10 minutes, at most 10 000 ids, in memory).
  A call or admin action sent again with the same id waits for the first one's answer, or gets it again, and does not
  run; the same id for another call is `invalid`. A read is remembered only until it answers (running one again is
  harmless, and its answer can be large).
- **The client** (`packages/client`) sends reads again on the new socket, since the manager may have restarted and
  forgotten the ids. A write, manage call or admin change already sent is not: it fails at once with code `unsure`
  (status 504), meaning it may or may not have gone through; the app decides (looks in Sent, asks the person). A call
  made while the socket was down was never sent, so it waits and goes on the next socket. The client finds an op's
  level in `@dither-accounts/interfaces` by its name; an op it does not know counts as a write.
- **An extractor** keeps its own record where a write cannot be undone: `mail.send`'s `idempotencyKey`
  (packages/link `once.ts`, docs/mail.md "Sending once").

Only code in this repo runs as an extractor. Apps ask for operations; they never bring code.

## The page

The page (say https://accounts.example.net) is for this machine and your tailnet, behind a login ([docs/auth.md](auth.md)):
one user (`admin`), a password kept only as an argon2id hash and set from this machine with
`bun packages/manager/src/cli.ts set-password --file <file>` (or on stdin; never in argv), and a session cookie that
lasts 90 days from its last use, at most a year. Until a password is set the page stays locked and says so. The login
form is a plain one your password manager fills; failed logins back off per address. **Sessions** lists the signed-in
browsers and signs any of them out, **Log out** is in the top bar, and setting the password again signs out all of them.
The page, its `/api/*`, `/oauth/*` and the live view socket all need the login, and a browser's writes must come from
the page's own origin; apps and extractors never log in (their own tokens, below), and `/api/health` says only `ok`.

- **Accounts** (the home page): every account by category (chat, mail, calendars and contacts, money, other), each
  named by who it is signed in as (its username or email, remembered while it is stopped) beside its service's mark,
  or by a nickname if you give it one; what needs you on top, and apps asking for access. **Add account** opens the
  services as marks by category (or search); a category's **+** opens its own, and its row of marks goes straight to
  one. A service with several ways in (Google in a browser or with your own OAuth client, Proton in a browser or
  through Bridge, Telegram by QR code or Telegram Desktop, Gmail, Fastmail and iCloud as presets of IMAP) shows them as
  buttons; the form asks only what that way needs, the rest under More options. `#/?add=<service or category>` opens
  it there, for an app to send you to (`?add=discord`, `?add=mail`). The services are in `web/src/catalog.ts`; a kind
  whose manifest has `add` but is not listed there still shows, under its own name. Apps that manage a kind add
  them too.
  Pick one for its pane, beside the list: who it is signed in as, its extractor's process and lock, the session
  facts its extractor reports, the apps that reach it, its call counts, its directory's files (names and sizes), its
  log, and its last `hello` and `status`. Its overview starts with what it rests on (`layers`, below), so a broken
  account says where it breaks. **Live view** opens its sandboxed browser (VNC carried through the manager) to sign
  in or watch it work. **Screen**, for a kind with a screen, picks the display backend its sandbox draws on, or the
  manager's default; **Screens**, at the foot of the home page, picks that default, which then wins over
  config.toml's `display_backend`. A backend built from a fork says "Experimental fork", and changing either restarts
  the sandboxes it moves (docs/browser.md, "Display backends"). What it needs from you shows on top: a QR code to scan, and for chat accounts a new code, a
  pairing code by phone number, or a password to sign in again. **Try it** runs any of its operations. Removing an
  account keeps its directory unless you tick "also delete it" (only for directories the manager made, never one
  imported in place).
- **Apps**: what each app asked for and may do; approve (narrower if you like), change, dry-run or revoke. **Who
  reaches what** is a grid of apps by accounts: in each cell the level per interface, whether the app runs the
  account, dry run, and a week of its calls with failures and denials in red; a cell opens that account's activity
  for the app.
- **Activity**: call counts by app, account, operation and outcome.
- **Interfaces**: every operation with the TypeScript types an app sees for its input and output, and the named types
  those use; any of them can be run on an account that offers it.

Running an operation from the page goes through the same input check, rate limit, call counts and dry run as an app's
call (counted as "This page"); writes ask first. The types come from the compiler, not the runtime schemas
(`s.typed<T>()` only knows "an object"): `bun run types` regenerates `packages/interfaces/src/types.generated.json`,
and a test fails when it is stale.

An extractor's `status` event may carry `liveView: { vncSocket, width, height }` (its VNC server's Unix socket), `self`
(who it is signed in as: `displayName`/`handle`/`avatarUrl`, or `email`), `details` (flat, non-secret session facts
the pane lists), `layers` (what the account rests on), `attention` (what it needs: a message, `qr` to draw,
`liveView` to open) and `changed: true` (a service it reads changed how it answers, and it reads around it: a notice,
docs/notifications.md, without the account needing you); the page shows each when it is there.

- `layers` is the account's dependency chain, outermost first, sent whole with each status:
  `[{ name, state: 'ok' | 'waiting' | 'failed' | 'off', note? }]`, e.g. Discord's display → browser → extension →
  hooks → first snapshot → online. The overview draws it as a chain (ok green, waiting amber, failed red, off grey,
  each note under its layer) and marks the first layer that is waiting or failed "This is where it stops". `off` is a
  layer the account does not use (Matrix encryption not set up), so it is never the stop. An extractor builds it
  from what it already knows, with no calls of its own; one that sends none shows none. The fakes take
  `failLayer`/`failNote` (and `noLayers`) in their config for tests.
- A layer only one of the account's interfaces rests on says which, `interface: 'mail'`: a Google account's `API key`
  and `Calendar API` are `google.calendar`'s, its Gmail layers `mail`'s. An app then reads the account's state per
  interface (the first layer not ok among those with no `interface` or with its own), so mail is not called broken
  for a failed Calendar API. The overview shows the interface under such a layer.
- Apps get each status's `liveView` as its width and height only, never the socket (so an app knows there is one): an
  app that runs the account opens the live view through the manager (`liveViewPath`). The page and `/api/liveview`
  keep the socket.
- No live view listens on a TCP port. A sandbox's x11vnc, Xvnc, wayvnc or w0vncserver (`packages/browser/src/vnc.ts`, `wayland.ts`) listens only on `vnc.sock` in
  the account's directory (0700, the socket 0600), so nothing but this user reaches it, and the manager connects only
  to a Unix socket this user owns: it carries the stream to the page behind its login, and to an app on its token. (A
  VNC without a password on 127.0.0.1, as it was, let in every local process, and any web page open in a browser
  here: libvncserver takes a WebSocket upgrade on its port from any Origin.)

## Apps that run accounts

Any app may list the kinds (`do: 'kinds'`): each kind's name, the interfaces its accounts offer, its add form (the
page's own, from its manifest) and whether this app may add one (`manages`), so an app can offer adding accounts beside
the page. An app with an `accounts` grant at manage for a kind runs accounts of that kind (`AccountsClient.admin`):
create them (with config and a secret, or with `form`, the answers to the kind's add form, which the manager splits into
config and secret.json and checks as its page does), rename, enable, disable, start, stop, restart, replace their
secret, read the tail of their log (`do: 'log'`), and remove them (`do: 'delete'`, with `purge` to delete a directory
the manager made). Its account list says, per account, why it is not running (`error`), whether it is asleep
(`asleep`: idle, its extractor stopped until a call wakes it, [docs/supervisor.md](supervisor.md#sleeping-browser-accounts-only-needed-now-and-then)), whether it may run it
(`manages`), whether it has a live view (`liveView`) and who made it (`origin`: this app, another app, the page, or an
import). The live view of an account it manages is a WebSocket on its own token, `client.liveViewUrl(account)` (spec
`liveViewPath`): the raw VNC stream, for the app to carry on to its own page, from this machine and never a browser.

## Layout

| | |
|---|---|
| `packages/spec` | schemas, interfaces, levels, consent lines, the consumer wire |
| `packages/interfaces` | `chat`, `google.calendar`, `calendar`, `contacts`, `mail`, `notifications` (with the manager's own notices about its accounts: [docs/notifications.md](notifications.md)), `desktop`, `exchange`, `privacy.session`, `statements` (financial accounts' pulled files, read only), `monero.view`, `approvals` (signed approval requests answered on paired approver devices, through the manager's built-in `approver` account: [docs/approver.md](approver.md#approvals)), `test.echo` |
| `packages/manager` | the service: registry (`db.ts`), extractor supervisor with the per-account lock, whose extractors outlive a restart and are adopted by the next manager, and whose idle browser accounts sleep until needed (`supervisor.ts`, `fingerprint.ts`, [docs/supervisor.md](supervisor.md)), router (`router.ts`), its error file (`errors.ts`, read by `bugwatch`), HTTP and sockets (`http.ts`), providers (`providers/google.ts`, the OAuth way in), CLI (`cli.ts`), page (`web/`), the sandboxes' programs built at start from the pinned nixpkgs (`prepare.ts`, [nix/README.md](../nix/README.md)) |
| `packages/browser` | a sandboxed browser for extractors: a screen of its own (Xvfb and x11vnc, or a headless sway and wayvnc: `src/screen.ts`, docs/browser.md "Display backends"), an ordinary Chromium with a persistent profile and an extension, the live view, the extension's loopback bridge, the names the extension leaves in pages, made per install and account when it is copied (`src/markers.ts`), what every hook shares to keep out of the page's sight (`src/page`, docs/page-traces.md), the profile's service workers cleared before a launch whose extension worker changed, since Chromium otherwise keeps running the first one (`src/worker.ts`) |
| `packages/sandbox` | a sandboxed native app for extractors: bubblewrap with its own network (pasta), its screen (either backend), a private session bus whose notifications and portals are ours, `xdg-open` shims, a watched downloads folder ([docs/native-sandbox.md](native-sandbox.md)) |
| `nix` | the one pinned nixpkgs (`pin.json`) and the list of programs the sandboxes and the tests run (`bins.json`), built by the manager and by CI the same way ([nix/README.md](../nix/README.md)) |
| `packages/approval` | approvals' statement (the bytes a device signs, dither-chat's contract), the request checks, P-256 signatures and fingerprints ([docs/approver.md](approver.md#approvals)) |
| `packages/client` | an app's side: `register`, `AccountsClient` with typed calls, admin actions |
| `packages/link` | an extractor's side (the same wire as dither-chat's adapter client) |
| `packages/chat-protocol` | dither-chat's protocol, copied under its old name so the chat extractors did not change |
| `apps/desk-signer` | the laptop's approver device: pairs, keeps its link, signs an approval after fprintd reports your finger ([apps/desk-signer/README.md](../apps/desk-signer/README.md)) |
| `extractors/*` | chat: `discord`, `signal`, `matrix`, `whatsapp` (moved from dither-chat), `telegram`, `gmessages` (Google Messages: SMS and RCS through your phone), `x` (X's direct messages, legacy DMs and encrypted XChat, from the real x.com client in a sandboxed browser: [docs/x.md](x.md)), `reddit` (a Reddit account's front page, inbox and comment threads as posts and a feed, from old.reddit.com signed in in a sandboxed browser: [docs/reddit.md](reddit.md)), `t3` (T3 Code's coding threads as chats, each a conversation with its agent: [docs/t3.md](t3.md)), `substack` (a Substack reader's Inbox, Notes, Activity and threads for the Feed page, from substack.com in a sandboxed browser: [docs/substack.md](substack.md)), `partiful` (Partiful's events by city and your own, who is going, comments and chats, from partiful.com in a sandboxed browser: [docs/partiful.md](partiful.md)), `luma` (Luma's events by city, your events, who is going, notifications, blasts and chats, from luma.com in a sandboxed browser: [docs/luma.md](luma.md)); `google` (a browser sign-in: Calendar, and Gmail read through its own page as `mail`), `google-api` (an OAuth client); `dav` (CalDAV and CardDAV), `ics` (read-only feeds); `imap` (mail, with a Proton Bridge preset); `proton` (Proton Mail signed in in a sandboxed browser, decrypted here: [docs/proton.md](proton.md)); `messenger` and `instagram` (Meta's web apps in a sandboxed browser, read and driven through their own modules; shared code in `meta`: [docs/messenger.md](messenger.md)); `privacy` (Privacy.com in a sandboxed browser whose extension carries its own passkey, signing itself in for its `statements`: [docs/privacy.md](privacy.md)); finance: `simplefin` (SimpleFIN Bridge: [docs/simplefin.md](simplefin.md)), `monero` (a view-only wallet: [docs/monero.md](monero.md)), `venmo`, `amazon` and `schwab` (statements, order history and Schwab's History and Realized Gain/Loss exports from sandboxed browsers, extension only: [docs/venmo.md](venmo.md), [docs/amazon.md](amazon.md), [docs/schwab.md](schwab.md)), all `statements` with shared code in `statements-common` ([docs/statements.md](statements.md)); `github` (notifications); `bugwatch` (your own services' error files and logs as notices, each new bug handed to a T3 coding thread: [docs/bugwatch.md](bugwatch.md)); `njalla` (DNS records as `dns`: [docs/njalla.md](njalla.md)); `fake`/`chat-fake` for tests |
