# Native apps in a sandbox we own

Chromium accounts are instrumented from inside: packages/browser loads our extension into an ordinary browser
window, and the extension sees the page. A native app (Telegram Desktop, Signal Desktop, a Qt or GTK client) has no
such door. But every app is a guest of its environment: it draws on a display, takes input from it, asks the session
bus for notifications and file dialogs, runs `xdg-open` to show a link, writes under `$HOME`, and talks to the network.
If we own that environment, we own every channel by which the app reaches outside itself, without touching the app.
That is `packages/sandbox`, and Telegram Desktop (docs/telegram.md) is its first tenant.

## What we own, for any app

| | how | what it gives us |
|---|---|---|
| **display and input** | a private Xvfb per account (only its path socket, no abstract one), x11vnc as the live view on `<account>/desktop/vnc.sock` and on no TCP port (bubblewrap shows the app only its home, bin/ and a few etc files, so the app can neither reach nor replace that socket); no window manager, so we keep the app's main window fitted to the display (xdotool) | the live view the page shows, where you use the real app (sign in with its own screens); screenshots; input if we ever need it |
| **the session bus and its services** | a private dbus-daemon; our own services own the well-known names before the app starts (`services.ts`) | `org.freedesktop.Notifications`: every notification as it is posted, replaced, closed, and its buttons pressable for the app. `org.freedesktop.portal.Desktop`: OpenURI (links), FileChooser (open and save dialogs, through Qt's `xdgdesktopportal` theme), Settings and NetworkMonitor (so GLib and Qt get true answers). `net.dither.Sandbox.Open`: what our `xdg-open` calls |
| **the filesystem** | bubblewrap: `/nix/store` read-only, a few `/etc` files (DNS, TLS roots, fonts, the clock), a synthetic `passwd`, `group` and `machine-id`; `HOME` is `<account>/desktop/home`; `/tmp` private | the app's data where we can read it (Telegram's tdata), and nothing of yours: not your home, your X server, your session bus or `/sys` |
| **PATH** | `/run/dither/bin` first: `xdg-open`, `x-www-browser`, `sensible-browser` and friends, each a shell script that calls `net.dither.Sandbox.Open` with `dbus-send`; then coreutils. GLib's default handler for http(s) and mailto is a `.desktop` file pointing at the same shim (`mimeapps.list`, merged with what the app writes there) | every "open this link" an app can make, whether through Qt (`QDesktopServices` runs `xdg-open`), GLib, or a portal |
| **the network** | its own network namespace through pasta (user-mode networking: out to the internet, nothing in, the host's loopback not mapped); `host` when pasta cannot be had (said in the status), `none` for tests | the app reaches Telegram and nothing on this machine: not the manager on 8486 (and no live view listens on a port to reach). And abstract unix sockets live in the network namespace: under the host's network, the app could reach every other Xvfb on the machine (the browser sandboxes' displays listen on abstract sockets, unauthenticated) |
| **processes** | the app under `bwrap --unshare-all` with `--die-with-parent`; a small environment (the extractor's own, with its manager token, never reaches even bubblewrap's init); a pid file so a later start ends what a killed extractor left | one account's app cannot see another's processes, or the extractor's secrets |

`bun test packages/sandbox` checks these against a real bus and a real sandbox: what the app inside can see (its own
home, its display, its bus; not the user's home, not the host's abstract X sockets, not `DITHER_*` anywhere, not its
own live view's socket), RFB on that socket (0600) from an x11vnc that holds no TCP or UDP socket, a link through the
shim and a download announced.

## The routing policy

Simple, and the same for every app:

- **Notifications** become events (`notify.new` on the `notifications` interface), with a bounded list in memory for
  `notify.list`. When the app takes one back (read elsewhere), `notify.read`. `notify.markRead` presses the app's own
  "Mark as read" button on it (ActionInvoked), then dismisses it, as a desktop does. We advertise `body`, `actions`,
  `inline-reply` and `sound`: with those, Telegram Desktop uses the desktop's notifications rather than drawing its own.
- **Links** are recorded and offered to the apps that subscribe (`desktop.link`, and `desktop.links`). Nothing is
  opened anywhere: there is no browser here, and an app that wants to follow a link fetches it itself.
- **Downloads** land in the sandbox's `~/Downloads` (Telegram Desktop's default folder is
  `~/Downloads/Telegram Desktop/`), and each file is announced (`desktop.download`) once it has stopped changing for
  2 s. `desktop.downloads` lists them, `desktop.fetch` reads one (64 MB at most). Files already there at start are
  listed but not announced again.
- **File dialogs**: "Save as" is answered at once with a path in `~/Downloads` under the name the app suggested (made
  unique), so it becomes a download. "Open" (attach a file) is answered with the files waiting in `~/Outbox`, which
  `desktop.offer` fills, or as cancelled when it is empty. Each dialog is a `desktop.fileRequest` event with its answer.
- **Calls that carry a file descriptor** (the OpenURI portal's OpenFile and OpenDirectory) are refused: this bus does
  not pass descriptors. Apps fall back to their own way, which for Telegram Desktop is a `file://` link through
  `xdg-open`.

Logs and status carry ids, counts and states; never a notification's text, a link, a file name or a key. The status
lists which bus methods the app has called and how often (`desktopBus`), which is how one sees that an app really
talks to our services.

## What is app-specific

Everything above is the same for any app. What is not:

- **Its session state on disk**, which is what makes the account an account: Telegram Desktop's `tdata` (the format,
  read and written in `extractors/telegram/src/tdata.ts`, is in docs/telegram.md). Another app has another format:
  Signal Desktop's SQLCipher database and the key in its `config.json` (or the OS keyring, which would then be a
  service we own on the bus), Element's IndexedDB.
- **How it is told where to keep that state, and to stay put**: Telegram Desktop takes `-workdir` and `-noupdate`
  (and has no updater in nixpkgs' build anyway); autostart is a file it may write into the sandbox's own
  `~/.config/autostart`, which nothing reads.
- **Which window to keep fitted**, and what its sign-in looks like in the live view.
- **What it says about itself** to its servers: Telegram Desktop's `initConnection` strings come from `/sys`, the
  window manager and glibc; in our sandbox they are fixed ("Desktop", "Linux X11 glibc 2.44"), which is how a client
  of ours on its key can say the same (docs/telegram.md).

## Deeper taps, and when each would be worth it

None of these is built; each is a door the sandbox already has the frame for.

- **AT-SPI accessibility**: an accessibility bus of our own (at-spi-bus-launcher on the sandbox's bus, Qt with
  `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`) exposes the app's widget tree: names, roles, text, actions. Worth it when the
  state we need is only on screen (neither on disk nor in a protocol we can speak), or to drive a flow by name instead
  of by coordinates ("press Start Messaging"). It reads everything the app shows, so it must never reach a log. It is
  slow and breaks with UI changes. Today `NO_AT_BRIDGE=1`.
- **LD_PRELOAD or Frida at the crypto boundary**: hooking `SSL_read`/`SSL_write` (or, for MTProto, the AES calls
  Telegram Desktop makes through OpenSSL) shows plaintext as the app sends and receives it. Worth it for an app whose
  protocol is undocumented, whose session cannot be reused outside it, or that pins certificates. It is per version
  (symbols, inlining, static builds), detectable, and against most apps' terms. Telegram does not need it: MTProto is
  documented and the session is on disk.
- **Passive MTProto decryption from a capture**: pasta can write the app's traffic to a pcap, and with the auth key
  from tdata MTProto 2.0's messages can be decrypted. But Telegram Desktop uses perfect forward secrecy: it encrypts
  with temporary keys bound to the permanent one (auth.bindTempAuthKey), negotiated per connection and only ever in
  memory; with the tdata key alone a capture stays sealed. It would take the temporary key from memory (the previous
  tap). Worth it only to see exactly what the official app sends (its update traffic, its initConnection), not for
  reading chats, which our own client does with its own key.

## Adding another native app

1. Its binary from nixpkgs (resolved by `resolveBin`: environment, PATH, `nix build`), its arguments to keep its data
   under the sandbox's home and not update itself.
2. `new AppSandbox({ dir: <account>/desktop, display, width, height, command, fitWindow, onEvent })` with a
   display from `pickFreeDisplay` (:80–:89, then :100–:159; claimed atomically in /tmp/.dither-displays so sandboxes
   starting together never pick the same one). Its live view is `sb.vncSocket` (`<dir>/vnc.sock`), reported as
   `liveView: { vncSocket, width, height }`.
3. Its session on disk: where it is, its format, when it says "signed in", and whether its key can be used from a
   client of our own or should only be watched.
4. Route `SandboxEvent`s onto interfaces (`notifications`, `desktop`, or the app's own), keeping text out of logs.
5. A fake of the app that runs in the real sandbox and uses the same channels (Telegram's is
   `extractors/telegram/test/fake-desktop.ts`), and a verify script that runs the real one up to its sign-in screen.
