# Haveno (kind `haveno`, interface `exchange`)

A Haveno node (the RetoSwap network, Monero peer-to-peer exchange) as an account: its wallet's balances, the offer book,
your offers and trades, trade chats and payment accounts, for apps to read and, with a write grant, to trade with. And
the Haveno desktop app on the same data, in this account's sandbox with a live view, when you want Haveno's own screens.

## The pieces

| | where | lifetime |
|---|---|---|
| **the node** | the headless daemon, which you run yourself (for example as a systemd unit); gRPC on 127.0.0.1:1201 by default (config `address`), data in `~/.local/share/Haveno-reto` by default (config `dataDir`) | always on; restarting dither-accounts never touches it |
| **the extractor** | `extractors/haveno`, a gRPC client of the node (`@grpc/grpc-js`, `proto/` from haveno-reto at the node's tag) | the manager's |
| **the desktop app** | a `haveno-desktop` launcher of the signed desktop jar (`HAVENO_DESKTOP_BIN`, else on `PATH`, else `nixpkgs#haveno-desktop`) in the account's sandbox, the data dir bound in | on demand, while you use it |

The node and the app must never run at once on the data: the daemon's unit and the launcher should both hold a flock
on `<data>/.instance.lock`, the launcher waiting for it. **openApp** stops the node through its API (a clean stop), and
the app's launcher waits for the lock. When the app quits, the node's service manager should bring it back (restart
after any exit) as soon as the lock is free, and the extractor opens the account again.
**closeApp** sends the app's window the close request a window manager would (WM_DELETE_WINDOW through libX11, since
the sandbox has no window manager): Haveno quits at once on its login screen and asks in the live view when trades or
offers are open. Its Ctrl+Q works too, but only after login. **closeApp {force: true}** kills it: the wallet survives
that, but it is a last resort, and it is what stopping the manager does to an app left open.

In the sandbox the app gets the data dir, read-only `/lib64` (nix-ld's shim: Haveno unpacks prebuilt `tor` and
`monero-wallet-rpc` and runs them; on NixOS the launcher points nix-ld at store paths, since `/run/current-system` is
not there) and pasta's network (out only).

## The account password

The account is encrypted with its password, and the node cannot open it by itself. **unlock {password, remember?}**
opens it and keeps the password in the extractor's memory, so the account opens again by itself after the node
restarts (the desktop app, an upgrade). With `remember: true` it also goes to `secret.json`, so it survives a manager
restart and a reboot; without it, a restarted manager asks again. **forget** drops it from both; **lock** also closes
the account. The page shows an Unlock form with a "remember" box when the account is locked.

The API password is the daemon's `--apiPassword`: `secret.json` `apiPassword` (the add form's field), or else a
`HAVENO_API_PASSWORD=…` line in an env file, `~/.config/haveno/daemon.env` by default (config `envFile`), the same
file your daemon's unit can read its password from.

## What apps get

`packages/interfaces/src/exchange.ts`. read: balances (piconero strings), prices, the offer book, your offers, trades,
a trade's chat, payment accounts and methods, a method's empty form. write: post and cancel offers, take offers,
paymentSent / paymentReceived, completeTrade, sendChat. manage: create and delete payment accounts, and the account
actions. Events: `exchange.trade` (from the node's TRADE_UPDATE notifications, and a poll of open trades that announces
what moved), `exchange.chat` (CHAT_MESSAGE, with `from` me / peer / support / system), `exchange.balances` (when they
change), `exchange.notice` (the node's errors).

**Nothing sends XMR out of the wallet**: withdrawals and transfers are left out on purpose, so a granted app or bot can
trade but never empty the wallet. Do those in the desktop app.

While the desktop app runs, every op answers 503 ("the desktop app has the account now").

## Status

Phases: `down` (the node does not answer), `denied` (wrong API password), `locked` (attention `login`), `opening`,
`syncing` (the wallet catches up: block n of m), `online`, `handover` (stopping the node for the app), `app` (attention
`app`, with the live view). Layers: node, account open, wallet and network, notifications, desktop app. Details carry
the balance in XMR words, open trades, wallet height, and where the password is kept; never the password, a chat or a
payment account's details.

## Tests

`test/haveno.test.ts`: a real manager, the fake daemon (`extractors/haveno/test/fake-haveno.ts`, the real gRPC
services over an in-memory node), and an app with a write grant: locked → unlock → online, every read and its
mapping, trading and its refusals, notifications as events, a restart that reopens the account, remember/forget, the
write grant's limits, a wrong API password, and the handover with a stand-in program in the real sandbox.
`extractors/haveno/test/try-real-app.ts` runs the real desktop app by hand up to its login screen (stop the node
first), takes a screenshot and closes it.

## Upgrading Haveno

Upgrade the daemon and the desktop app together, each release file (daemon jar, desktop .deb) checked against Reto's
signature (key DAA2 4D87 8B8D 36C9 0120 A897 CA02 DAC1 2DAE 2D0F). Back up the data dir first; a new version
migrates it one way. Then copy `proto/grpc.proto` and `proto/pb.proto` from haveno-reto at the new tag into
`extractors/haveno/proto`.
