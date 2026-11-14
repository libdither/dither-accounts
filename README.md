# dither-accounts

One self-hosted place for your signed-in accounts. **Extractors** hold each account's session (a Discord web client
in a sandbox, a Signal or WhatsApp linked device, a Matrix login, Google Calendar signed in in a sandboxed browser). **Apps** (dither-chat,
dither-calendar, anything else) ask for **interfaces** on accounts at a **level**; you approve on the manager's page,
and the manager routes their calls and the accounts' events between them. It keeps nothing an account says.

```
                 consent page (accounts.example.net)
                                  │ approve / revoke / dry run
 dither-chat hub ─┐               ▼
 dither-calendar ─┼─ /consumer ─▶ manager ─ /extractor ─▶ extractors/discord, signal, matrix, whatsapp, google …
 any app ─────────┘   (calls, events)  grant → input → limit → audit → dry run → extractor
```

It is built for one person on their own machine: you run it, you are its only user, and the accounts are yours.

## Supported sources

- **Chat:** Discord, Signal, WhatsApp, Matrix, Telegram, Google Messages (SMS and RCS through your phone), X direct
  messages, Messenger and Instagram direct messages; and T3 Code's coding threads, each a chat with its agent.
- **Mail, calendars and contacts:** Google (Calendar and Gmail, signed in in a sandboxed browser, or through your own
  OAuth client), Proton Mail (in a sandboxed browser, or through Bridge), IMAP (with Gmail, Fastmail and iCloud
  presets), CalDAV and CardDAV, read-only ICS feeds.
- **Money (statements for an app such as [dither-finance](https://github.com/libdither/dither-finance)):**
  SimpleFIN Bridge, Charles Schwab (History and Realized Gain/Loss exports), Privacy.com, Venmo, Amazon order
  history, a Monero view-only wallet, and a Haveno node.
- **Other:** GitHub notifications, Njalla DNS records, and Claude subscriptions for a CLIProxyAPI hub.

Each kind's doc in [docs/](docs) says what it needs from you and what only a real account can check.

## Getting started

Requires [Bun](https://bun.sh) (CI's version is in [.github/workflows/ci.yml](.github/workflows/ci.yml)). The
sandboxed-browser and native-app kinds also need Xvfb, Chromium, x11vnc, bubblewrap and pasta on the machine; the
others need nothing more.

```sh
bun install
bun run web:build
export DITHER_ACCOUNTS_DATA=~/.local/share/dither-accounts      # state: accounts, sessions, the registry (0700)
mkdir -p -m 700 "$DITHER_ACCOUNTS_DATA"
cp config.example.toml "$DITHER_ACCOUNTS_DATA/config.toml"     # optional: every setting has a default
bun packages/manager/src/cli.ts set-password --file <file>     # the page's password (or on stdin)
bun packages/manager/src/main.ts                               # the manager and its page, on 127.0.0.1:8486
```

Open http://localhost:8486, sign in as `admin`, and add an account. Apps register themselves with the manager and
wait on the page (**Apps**) until you approve what they ask for.

## Configuration

`<data>/config.toml`, the `[manager]` table: the address and port the manager listens on, the page's URL as a browser
opens it (`public_url`; the page accepts writes only from that origin, and passkeys and OAuth redirects are bound to
it), where the built page is, and whether to write trace files. [config.example.toml](config.example.toml) lists every
key with its default. A flag (`--public-url`) or its environment variable (`DITHER_ACCOUNTS_PUBLIC_URL`) wins over
the file. The data directory itself is `--data` or `DITHER_ACCOUNTS_DATA` (default: `.data` in the checkout).

Each account's own settings (a homeserver, an email, which mail account carries its sign-in links) are set on the
page when you add it, and kept in its directory.

## Security model

dither-accounts holds live sessions and credentials for your accounts, so whoever controls it controls them. Know
where they are:

- **Credentials are stored unencrypted, protected by file permissions.** Each account has a directory,
  `<data>/accounts/<id>/` (mode 0700). Its `secret.json` (0600) holds what you gave it: tokens, passwords, app
  passwords, and the private keys of the passkeys the account made for itself. Its browser profile or linked-device
  store (cookies, Signal and WhatsApp keys, Telegram's `tdata`) sits beside it. Anyone who can read your user's files,
  or a backup of the data directory, can act as you on every account. Use full-disk encryption and treat the data
  directory as a secret.
- **Secrets stay with their extractor.** The manager writes `secret.json` and starts the account's extractor; the
  page and apps never see a secret's value, only which keys exist. Logs name steps and paths, not values. A passkey's
  private key never enters the browser: the extractor answers the page's WebAuthn calls, and checks which frames and
  origins may ask. The approver phone app ([docs/approver.md](docs/approver.md)) can hold passkeys instead, so
  each use needs your approval on the phone.
- **Money kinds read.** The finance kinds pull statements and history; none of them pays, trades or moves money. The
  Monero kind is a view-only wallet: never give it a spend key.
- **The page** answers only loopback and Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48), behind a login:
  one user, a password kept as an argon2id hash and set only from this machine, a session cookie, writes only from
  the page's own origin, and failed logins backed off per address ([docs/auth.md](docs/auth.md)). The manager listens
  on 127.0.0.1 unless you say otherwise; put a reverse proxy with TLS in front of it to reach it from other devices.
- **Apps** get a token at registration (stored as its SHA-256), ask for interfaces at a level, and get only what you
  approve. Every call passes the grant check, an input check and rate limits, and can be answered by a dry run.
  Only code in this repo runs as an extractor; apps never bring code.
- **Live views** (VNC of a sandboxed browser or app) listen only on a Unix socket in the account's directory, and
  reach a browser only through the page, behind its login.

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

Interfaces now: `chat` (dither-chat's adapter protocol), `google.calendar`, and `test.echo`.

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

Only code in this repo runs as an extractor. Apps ask for operations; they never bring code.

## The page

The page (say https://accounts.example.net) is for this machine and your tailnet, behind a login ([docs/auth.md](docs/auth.md)):
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
  in or watch it work. What it needs from you shows on top: a QR code to scan, and for chat accounts a new code, a
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
the pane lists), `layers` (what the account rests on) and `attention` (what it needs: a message, `qr` to draw,
`liveView` to open); the page shows each when it is there.

- `layers` is the account's dependency chain, outermost first, sent whole with each status:
  `[{ name, state: 'ok' | 'waiting' | 'failed' | 'off', note? }]`, e.g. Discord's display → browser → extension →
  hooks → first snapshot → online. The overview draws it as a chain (ok green, waiting amber, failed red, off grey,
  each note under its layer) and marks the first layer that is waiting or failed "This is where it stops". `off` is a
  layer the account does not use (Matrix encryption not set up), so it is never the stop. An extractor builds it
  from what it already knows, with no calls of its own; one that sends none shows none. The fakes take
  `failLayer`/`failNote` (and `noLayers`) in their config for tests.
- Apps get each status's `liveView` as its width and height only, never the socket (so an app knows there is one): an
  app that runs the account opens the live view through the manager (`liveViewPath`). The page and `/api/liveview`
  keep the socket.
- No live view listens on a TCP port. A sandbox's x11vnc (`packages/browser/src/vnc.ts`) listens only on `vnc.sock` in
  the account's directory (0700, the socket 0600), so nothing but this user reaches it, and the manager connects only
  to a Unix socket this user owns: it carries the stream to the page behind its login, and to an app on its token. (A
  VNC without a password on 127.0.0.1, as it was, let in every local process, and any web page open in a browser
  here: libvncserver takes a WebSocket upgrade on its port from any Origin.)

## Apps that run accounts

An app with an `accounts` grant at manage for a kind runs accounts of that kind (`AccountsClient.admin`): create them
(with config and a secret), rename, enable, disable, start, stop, restart, replace their secret, read the tail of their
log (`do: 'log'`), and remove them (`do: 'delete'`, with `purge` to delete a directory the manager made). Its account
list says, per account, why it is not running (`error`), whether it may run it (`manages`), whether it has a live view
(`liveView`) and who made it (`origin`: this app, another app, the page, or an import). The live view of an account it
manages is a WebSocket on its own token, `client.liveViewUrl(account)` (spec `liveViewPath`): the raw VNC stream, for
the app to carry on to its own page, from this machine and never a browser.

## Layout

| | |
|---|---|
| `packages/spec` | schemas, interfaces, levels, consent lines, the consumer wire |
| `packages/interfaces` | `chat`, `google.calendar`, `calendar`, `contacts`, `mail`, `notifications` (with the manager's own notices about its accounts: [docs/notifications.md](docs/notifications.md)), `desktop`, `exchange`, `privacy.session`, `statements` (financial accounts' pulled files, read only), `monero.view`, `test.echo` |
| `packages/manager` | the service: registry (`db.ts`), extractor supervisor with the per-account lock, whose extractors outlive a restart and are adopted by the next manager (`supervisor.ts`, `fingerprint.ts`, [docs/supervisor.md](docs/supervisor.md)), router (`router.ts`), its error file (`errors.ts`, read by `bugwatch`), HTTP and sockets (`http.ts`), providers (`providers/google.ts`, the OAuth way in), CLI (`cli.ts`), page (`web/`) |
| `packages/browser` | a sandboxed browser for extractors: Xvfb, an ordinary Chromium with a persistent profile and an extension, x11vnc for the live view, the extension's loopback bridge, the names the extension leaves in pages, made per install and account when it is copied (`src/markers.ts`), what every hook shares to keep out of the page's sight (`src/page`, docs/page-traces.md), and the profile's service workers cleared before a launch whose extension worker changed, since Chromium otherwise keeps running the first one (`src/worker.ts`) |
| `packages/sandbox` | a sandboxed native app for extractors: bubblewrap with its own network (pasta), Xvfb and x11vnc, a private session bus whose notifications and portals are ours, `xdg-open` shims, a watched downloads folder ([docs/native-sandbox.md](docs/native-sandbox.md)) |
| `packages/client` | an app's side: `register`, `AccountsClient` with typed calls, admin actions |
| `packages/link` | an extractor's side (the same wire as dither-chat's adapter client) |
| `packages/chat-protocol` | dither-chat's protocol, copied under its old name so the chat extractors did not change |
| `extractors/*` | chat: `discord`, `signal`, `matrix`, `whatsapp` (moved from dither-chat), `telegram`, `gmessages` (Google Messages: SMS and RCS through your phone), `x` (X's direct messages, legacy DMs and encrypted XChat, from the real x.com client in a sandboxed browser: [docs/x.md](docs/x.md)), `t3` (T3 Code's coding threads as chats, each a conversation with its agent: [docs/t3.md](docs/t3.md)); `google` (a browser sign-in: Calendar, and Gmail read through its own page as `mail`), `google-api` (an OAuth client); `dav` (CalDAV and CardDAV), `ics` (read-only feeds); `imap` (mail, with a Proton Bridge preset); `proton` (Proton Mail signed in in a sandboxed browser, decrypted here: [docs/proton.md](docs/proton.md)); `messenger` and `instagram` (Meta's web apps in a sandboxed browser, read and driven through their own modules; shared code in `meta`: [docs/messenger.md](docs/messenger.md)); `privacy` (Privacy.com in a sandboxed browser whose extension carries its own passkey, signing itself in for its `statements`: [docs/privacy.md](docs/privacy.md)); finance: `simplefin` (SimpleFIN Bridge: [docs/simplefin.md](docs/simplefin.md)), `monero` (a view-only wallet: [docs/monero.md](docs/monero.md)), `venmo`, `amazon` and `schwab` (statements, order history and Schwab's History and Realized Gain/Loss exports from sandboxed browsers, extension only: [docs/venmo.md](docs/venmo.md), [docs/amazon.md](docs/amazon.md), [docs/schwab.md](docs/schwab.md)), all `statements` with shared code in `statements-common` ([docs/statements.md](docs/statements.md)); `github` (notifications); `bugwatch` (your own services' error files and logs as notices, each new bug handed to a T3 coding thread: [docs/bugwatch.md](docs/bugwatch.md)); `njalla` (DNS records as `dns`: [docs/njalla.md](docs/njalla.md)); `fake`/`chat-fake` for tests |

[docs/chat.md](docs/chat.md): the chat extractors, what they need, adding them here, importing from dither-chat.
[docs/google.md](docs/google.md): Google signed in in a sandboxed browser (Calendar, and Gmail read-only through its own web protocol; and what is not yet proven about it), or through your own OAuth client.
[docs/messenger.md](docs/messenger.md): Messenger and Instagram direct messages from their web apps, the hooks into their own modules, how to tell from the status which one broke, and the real-account checklist.
[docs/native-sandbox.md](docs/native-sandbox.md): native apps (Telegram Desktop, Haveno) in a sandbox whose display, bus, files, PATH and network are ours, and the deeper taps we have not needed.
[docs/x.md](docs/x.md): X's direct messages read and written from inside x.com's own chat client (now ES modules and a Kotlin/JS core, not webpack), its hooks and their fallbacks, how the status says which one broke, and your real-account checklist.
[docs/statements.md](docs/statements.md): financial accounts as files for an app such as dither-finance, the spool, the daily pull, Python's JSON; [docs/simplefin.md](docs/simplefin.md), [docs/monero.md](docs/monero.md), [docs/venmo.md](docs/venmo.md), [docs/amazon.md](docs/amazon.md) and [docs/schwab.md](docs/schwab.md) are its kinds.
[docs/notifications.md](docs/notifications.md): the `notifications` interface, its `urgency`, and the built-in `notices` account that says when an account needs you.
[docs/bugwatch.md](docs/bugwatch.md): your own services' errors as notices (the manager's error file among them), fingerprints, what is a bug, and the T3 threads it starts for them, capped.
[docs/t3.md](docs/t3.md): T3 Code's threads as chats: the sessions it makes, the shell stream, what shows and what is not built.
[docs/telegram.md](docs/telegram.md), [docs/gmessages.md](docs/gmessages.md), [docs/dav.md](docs/dav.md), [docs/ics.md](docs/ics.md), [docs/mail.md](docs/mail.md), [docs/github.md](docs/github.md): each with what you have to do and what only a real account can check.

## Licence

dither-accounts is free software under the **GNU Affero General Public License, version 3 or later**
([LICENSE](LICENSE)): if you run a changed version for others over a network, offer them its source. Within it:

- `extractors/gmessages/bridge` is built on mautrix's libgm (AGPL-3.0-or-later, its own LICENSE).
- `extractors/haveno/proto` is haveno-reto's gRPC schema (AGPL-3.0; `grpc.proto` keeps Bisq's header), loaded only
  to speak to a node ([its README](extractors/haveno/proto/README.md)).
- The WhatsApp bridge links whatsmeow (MPL-2.0) and go.mau.fi/libsignal (GPL-3.0), so a built bridge binary is
  GPL-3.0, which the AGPL (section 13) lets it be combined with.
- The page uses noVNC and ical.js (MPL-2.0) and openpgp (LGPL-3.0-or-later) unmodified, from npm.

Brand marks on the page are Simple Icons (CC0-1.0); the names are their owners' trademarks, used only to say which
service an account is.

## Run

```sh
bun packages/manager/src/main.ts [--data <dir>] [--port 8486] [--host 127.0.0.1] [--public-url https://accounts.example.net]
```

It listens on 127.0.0.1 unless told otherwise. To reach the page from your other devices, put it behind a reverse
proxy on this machine with your own name and certificate (Caddy on your tailnet, say), set `public_url` to that name,
and set `host = "0.0.0.0"` if the proxy reaches it at the machine's tailnet address rather than loopback. A systemd
user unit is a good home for it:

```ini
[Service]
WorkingDirectory=%h/src/dither-accounts
Environment=DITHER_ACCOUNTS_DATA=%h/.local/share/dither-accounts
ExecStart=/usr/bin/env bun packages/manager/src/main.ts
KillMode=mixed
Restart=always
```

The sockets and app registration answer only this machine; the page answers this machine and the tailnet, after the
login. Restarting the service does not restart the accounts: under systemd each extractor runs in a scope of its own,
keeps its session while the manager is away, and the next manager adopts it, restarting only those whose code changed,
one at a time ([docs/supervisor.md](docs/supervisor.md)).

```sh
bun packages/manager/src/cli.ts accounts            # what runs, where
bun packages/manager/src/cli.ts apps                # apps, their grants and requests
bun packages/manager/src/cli.ts approve <request>   # or on the page
bun packages/manager/src/cli.ts import-dither-chat --hub-data <dither-chat data dir> --accounts <id>
bun packages/manager/src/cli.ts forget <id>         # hand an account back (its directory stays)
bun packages/manager/src/cli.ts set-password --file <file>   # the page's password (or on stdin); signs every browser out
bun packages/manager/src/cli.ts sessions | revoke-sessions   # the page's signed-in browsers
bun packages/manager/src/cli.ts export-to-dither-chat <id> --hub-data <dither-chat data dir>
                                                    # hand back one the manager made: copied, checked, then forgotten
```

Moving a dither-chat account here and back is in dither-chat's `docs/accounts.md`.

## Test

```sh
bun test                    # the manager over the real wire with fake extractors, both Google kinds against a fake Google (the browser one in a real Chromium), every chat extractor's own suite
bun run typecheck           # the services and the page (both tsconfigs)
bun scripts/verify-ui.ts …  # the page in headless Chromium against a fresh manager (see its header)
bun scripts/verify-chat-add.ts [shots]  # chat accounts added on the page reach a throwaway dither-chat hub (Matrix testbed, fake Signal and WhatsApp)
```

## Contributing

Pull requests are welcome. Read [AGENTS.md](AGENTS.md) first: above all, no personal data in the repo (real names,
handles, account ids, amounts, hostnames, captured pages or sessions), in code, tests, fixtures or commit messages.
CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `bun run typecheck`, `bun run web:build` and
`bun run test`; the sandboxed kinds' tests skip on GitHub's runners (no Xvfb or Chromium), so run those on a machine
that has them before a PR that touches them.
