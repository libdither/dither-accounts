# The `browser` interface: an account's own browser, driven like a person drives it

Some jobs on a site are too small or too rare for a kind to have an operation for them, such as putting
something in a cart, looking at a page, or filling in one form. For those, a browser kind can lend its signed-in
browser through the `browser` interface (`packages/interfaces/src/browser.ts`). An app or agent then opens a tab
on the account's site, reads it, and clicks and types in it, as the owner would in the live view.

It is offered today by the extension-only browser kinds on `statements-common`: `amazon`, `venmo` and `schwab`
(`extractors/statements-common/src/browser-ops.ts`, plus `extension/browser.js` appended to their driver). Another
kind built on `BrowserHost` gets it with three lines: a `BrowserOps` beside its host, `browserOps.handle(cmd)` in
its `onCommand`, and `'browser'` in its manifest's and hello's `interfaces`.

## What it does

| op | level | |
|---|---|---|
| `browser.tabs` | read | the tabs this interface opened, newest first |
| `browser.read` | read | the page's text and its interactive elements, each with a ref (`e1`, `e2`…) |
| `browser.shot` | read | a PNG of the account's display, with the tab in front: what the live view shows |
| `browser.open` / `browser.go` | write | load a URL of the account's site, in a new tab (in front) or in one of its own |
| `browser.click` | write | a real mouse click on an element, then wait for a page it loads |
| `browser.type` | write | click a field and type into it with real key presses (`clear`, `enter`) |
| `browser.select` | write | pick a `<select>`'s option |
| `browser.key` / `browser.scroll` | write | key presses (xdotool's names, on either display backend), or about a screen of scrolling |
| `browser.close` | write | close one of its tabs |
| `browser.press` | manage | a click that may buy, pay, send or delete |

Every answer to a write says where the tab is now (`url`, `title`) and carries `challenge` when the page asks for
something only a person may give.

## How it stays a person's browser

- **Real input.** The extension only reads the page and says where an element's middle is on the screen. The
  extractor owns the account's display, and it moves the mouse, clicks and types there: with xdotool on the x11
  backend, through the live view's own socket on the wayland one (below). So the site gets trusted events from an
  ordinary window, as it does from the owner: no synthetic events, no DevTools and no automation flags. The one exception is `browser.select`, which sets a `<select>`'s value and fires its input and
  change events, because a native select's list is a popup outside the page.
- **Refs.** `browser.read` lists links, buttons, fields, selects, checkboxes and ARIA widgets that are shown, in page
  order, with their role, accessible name and value. A password field shows only whether it is filled. The refs live
  in the extension's isolated world, which the page can't see, and they hold until the next read or a page load.
  After that a ref answers 404 "read the page again".
- **Its own tabs only.** The kind's own tabs (a pull, a sign-in) are never read or touched. A tab id this interface
  didn't open answers 403. A tab left idle for 15 minutes is closed.
- **The account's site only.** A URL outside the extension's `host_permissions` answers 403. A page that leaves the
  site can't be read, because the extension has no access there.
- **One call at a time.** Two callers' clicks never interleave. While the kind is pulling, anything that would bring
  a tab forward answers 409 `busy`.

## Display backends

Every sandbox (the browser kinds', Discord's, and the native apps': Signal Desktop, Telegram Desktop) draws on a
screen of its own, made by one of two backends behind one abstraction (`packages/browser/src/screen.ts`). Both give
the same things: a live view on `<account>/vnc.sock` (or `<account>/desktop/vnc.sock`) that the manager's page
shows unchanged, real clicks at an element's middle, typed text, xdotool's key names, and a PNG of the screen.

| | `x11` (the default) | `wayland` |
|---|---|---|
| screen | Xvfb on a free display number (`:80`–`:89`, `:100`–`:159`; Discord `:91`–`:99`) | a headless sway of the sandbox's own; its sockets in `<account>/wl` (0700), or in `$XDG_RUNTIME_DIR/dither-wl/<hash>` when the account's path leaves no room for sway's socket names; no display number, nothing in /tmp |
| live view | x11vnc on the socket | wayvnc on the same socket (no TCP or UDP port, no abstract socket) |
| input | xdotool | an RFB client of the sandbox's own on that socket: wayvnc turns it into the seat's virtual pointer and keyboard |
| text no US key makes (é, €, emoji) | xdotool's keysyms | an input method (input-method-v2 → the field's text-input-v3), as a person with an IME types it |
| picture | ImageMagick's `import` | grim |
| apps | `DISPLAY` | Chromium `--ozone-platform=wayland`; native apps get only the compositor's socket, as `<run>/wayland-0`, with Qt, GTK, SDL and Electron told to use it, and no X socket at all |

**Choosing.** The manager's `display_backend` (`--display-backend`, `DITHER_ACCOUNTS_DISPLAY_BACKEND`, or
config.toml) is the default for every account, `x11` unless set. An account's config can name its own,
`displayBackend`: `bun packages/manager/src/cli.ts display <account> wayland` (or `default` to follow the manager),
or `{ "settings": { "displayBackend": "wayland" } }` in a PATCH of `/api/accounts/<id>`. The account's extractor
restarts to take it. The extractor gets the result as `DITHER_DISPLAY_BACKEND`, and the account's detail shows it
(`process.displayBackend`). A manager that adopts extractors started with another backend restarts them one at a time,
as it does for changed code (docs/supervisor.md). Haveno follows it too: JavaFX draws only through X, so on wayland it gets an Xwayland of its own inside its sandbox (xwayland-satellite: docs/native-sandbox.md).

**Why sway, not cage.** cage 0.3 as nixpkgs builds it always starts Xwayland, which takes a global X display number
and an abstract socket, the two things this backend is for getting rid of. It also has no IPC (to close a window as a
window manager does, or to know the output and seat are ready), needs another tool to size its output, and exits when
its one app does. sway with `xwayland disable` listens on its Wayland socket and its IPC socket and nothing else.

**What a page sees.** Chromium 155 compared on both, same flags, same machine:

- The same: `navigator.platform` (Linux x86_64), the user agent (Chromium still says X11 in it), client hints, the
  screen (the sandbox's size), device pixel ratio, colour depth, fonts, and the unmasked WebGL renderer (the GPU's,
  through ANGLE on Vulkan). sway renders with gles2 on the machine's render node for that: under pixman Chromium's
  GPU process loses WebGL or hangs, so pixman is used only where there is no render node.
- Made the same: a fine pointer, hover and `document.hasFocus()`. Without a pointer and keyboard on the seat a
  Wayland page has none of them; wayvnc makes them only while a client is connected, so the sandbox keeps its own
  connected for as long as it runs.
- Made the same: the window's size. With Chromium's own title bar, a Wayland window counts its client-side shadows
  in its size even when tiled (outer 1300×920 on a 1280×900 screen, wider than the screen itself), and the first
  page after a start saw its floating size (inner 1248×771). So a profile on wayland uses the system's title bar
  (`browser.custom_chrome_frame` off; sway draws none), and the window is the screen's size from the first frame.
- Still different, by a pixel or three: on x11 the window is one pixel short of the screen (outer 1279×899, inner
  1279×812 at 1280×900); on wayland it fills it (outer 1280×900, inner 1280×813). `document.hasFocus()` is false in
  the very first script on wayland (the seat's focus lands a moment later) and true on x11.

**Windows.** sway tiles the app's main window, so it fills the screen (on x11 Chromium's `--window-size` does
that, and the native sandbox's fit loop). A window that opens while a tiled one is there floats at its own size, as
a dialog does. That is decided once per window as it opens: a sway `for_window` rule would run again on every title
change (a chat's unread count) and float the main window too.

**Limits.** Discord's extension port is picked free on wayland (on x11 it comes from the display number). No
clipboard tool is used on either backend. An extractor killed outright leaves its compositor's directory (its config
and wayvnc's control socket); the next start on that account empties it.

## What it won't do

- **Buy, pay, send or delete below `manage`.** A button or link whose words say so (Buy Now, Place your order, Pay,
  Send, Transfer, Delete, Subscribe…) is marked `guarded` in a read. `browser.click` refuses it, and so does a
  Return or space key pressed while it has the focus (403 `guarded`). Only `browser.press` presses it, and that op
  is at `manage`. This is best effort, going by the button's words; the grant is the real line. Give agents
  `write`.
- **Solve a challenge.** A captcha, an "I am human" checkpoint, a code by text or email or an unusual-activity page
  comes back as `challenge` and is logged. Nothing here answers one: the owner clears it in the live view. The
  kind's own pulls see the same page and hold the account as they always do.
- **Log what it reads or types.** The log names the op, the site and counts, never typed text or page contents.

## From the command line: `scripts/browse.ts`

```
bun scripts/browse.ts accounts
bun scripts/browse.ts --account amazon open https://www.amazon.com/dp/<ASIN>
bun scripts/browse.ts --account amazon read           # elements with refs, then the text
bun scripts/browse.ts --account amazon click e42
bun scripts/browse.ts --account amazon shot cart.png
bun scripts/browse.ts --account amazon close
```

It is an app named `browser-cli`. Its first run registers it with a request for `browser` at `write`; the owner
approves it on the manager's page for the accounts it may drive. Its token goes in
`~/.config/dither-accounts/browser-cli.json`. A challenge prints `CHALLENGE` and exits 3.

## Tests

`extractors/amazon/test/browser.test.ts` runs the interface against the fake Amazon's product page. It checks that a
URL off the site is refused, that the elements and their refs come back from a read, and that a select, typing and
a real click (`isTrusted`) add to the cart. It also checks that Buy Now is refused to `browser.click`, that a stale
ref is caught, that the screenshot is a PNG, and that a closed tab is gone.

`packages/browser/test/wayland.test.ts` covers the wayland backend: its parts on their own (the key names, text split
into keys and input-method runs, the Wayland and sway IPC wire, the RFB handshake against a stand-in server, the
config and flags), then a real headless sway and wayvnc (RFB on the socket and nothing else, no TCP or abstract
socket, the seat's pointer and keyboard, grim's PNG), then Chromium on it: a click, Shift-held capitals, é, € and an
emoji typed into a field arrive as trusted input with the right `code`s, and the page has a fine pointer and hover.
`packages/sandbox/test/sandbox-wayland.test.ts` runs a native app on it and checks it sees only `wayland-0`, no X.
Both skip without sway, wayvnc and grim (and Chromium for the last part), as on CI's runners.
