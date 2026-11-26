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
screen of its own, made by one of the backends behind one abstraction (`packages/browser/src/screen.ts`). All give
the same things: a live view on `<account>/vnc.sock` (or `<account>/desktop/vnc.sock`) that the manager's page
shows unchanged, real clicks at an element's middle, typed text, xdotool's key names, and a PNG of the screen.

| | `x11` (the default) | `tigervnc`, `turbovnc` | `wayland`, `wayland-tigervnc` |
|---|---|---|---|
| screen | Xvfb on a free display number (`:80`–`:89`, `:100`–`:159`; Discord `:91`–`:99`) | Xvnc on a free display number from the same ranges: X server and VNC server in one process | a headless sway of the sandbox's own; its sockets in `<account>/wl` (0700), or in `$XDG_RUNTIME_DIR/dither-wl/<hash>` when the account's path leaves no room for sway's socket names; no display number, nothing in /tmp |
| live view | x11vnc on the socket | the same Xvnc, on the socket (`-rfbunixpath`), with no TCP port (`-rfbport -1` for TigerVNC; TurboVNC opens none once given a path) | wayvnc (`wayland`) or TigerVNC's w0vncserver (`wayland-tigervnc`) on the same socket (no TCP or UDP port, no abstract socket) |
| input | xdotool | xdotool | an RFB client of the sandbox's own on that socket: the live view's server turns it into the seat's virtual pointer and keyboard |
| text no US key makes (é, €, emoji) | xdotool's keysyms, each character first put on a key of its own for the screen's life (xmodmap): bound and unbound around each press, as xdotool does alone, an app can miss it | the same | an input method (input-method-v2 → the field's text-input-v3), as a person with an IME types it |
| picture | ImageMagick's `import` | ImageMagick's `import` | grim |
| apps | `DISPLAY` | `DISPLAY` | Chromium `--ozone-platform=wayland`; native apps get only the compositor's socket, as `<run>/wayland-0`, with Qt, GTK, SDL and Electron told to use it, and no X socket at all |

**Choosing.** The manager's `display_backend` (`--display-backend`, `DITHER_ACCOUNTS_DISPLAY_BACKEND`, or
config.toml) is the default for every account, `x11` unless set: `x11`, `tigervnc`, `turbovnc`, `wayland` or
`wayland-tigervnc`. An
account's config can name its own, `displayBackend`: `bun packages/manager/src/cli.ts display <account> tigervnc` (or
`default` to follow the manager), or `{ "settings": { "displayBackend": "tigervnc" } }` in a PATCH of
`/api/accounts/<id>`. `kasmvnc` is refused there, with the reason (below). The account's extractor
restarts to take it. The extractor gets the result as `DITHER_DISPLAY_BACKEND`, and the account's detail shows it
(`process.displayBackend`). A manager that adopts extractors started with another backend restarts them one at a time,
as it does for changed code (docs/supervisor.md). Haveno follows it too: JavaFX draws only through X, so on wayland it gets an Xwayland of its own inside its sandbox (xwayland-satellite: docs/native-sandbox.md).

**Why sway, not cage.** cage 0.3 as nixpkgs builds it always starts Xwayland, which takes a global X display number
and an abstract socket, the two things this backend is for getting rid of. It also has no IPC (to close a window as a
window manager does, or to know the output and seat are ready), needs another tool to size its output, and exits when
its one app does. sway with `xwayland disable` listens on its Wayland socket and its IPC socket and nothing else.

**The Xvnc backends.** `tigervnc` (TigerVNC's Xvnc, nixpkgs `tigervnc`) and `turbovnc` (TurboVNC's, nixpkgs
`turbovnc`) are X servers with the VNC server inside: to an app they are an X display like Xvfb, so everything x11
does works the same way on them (xdotool, `import`, the clipboard through xclip both ways, X-only apps such as Haveno,
display picking and its locks, Chromium capturing the screen for a share, a takeover after a hard kill), and the
tests run each of those on each Xvnc (`packages/browser/test/xvnc.test.ts`, `packages/sandbox/test/sandbox-xvnc.test.ts`,
`screenshare.test.ts`). What changes is the live view: no x11vnc reading the screen back through System V shared
memory, so an Xvnc sandbox holds no shm segment (an x11 one about 42, from a machine-wide limit of 4096), and one
process instead of two. Each runs with `-nolisten tcp`, no security type (the socket is the account's, 0700), always
shared (the manager's view and a sandbox's own client at once), and `HOME` in `<account>/xvnc-home`, where it keeps
what it writes. TigerVNC answers noVNC's list (Tight first) with its JPEG encoding for photo-like areas and Tight for
the rest; TurboVNC with Tight and JPEG subrects. `-rfbport -1` is TigerVNC's way to open no port; TurboVNC opens none
once given `-rfbunixpath` and refuses `-rfbport -1`. TurboVNC runs with `-deferupdate 1`: by default it holds each
change 40 ms to send more at once, which kept its live view near 20 frames a second and added 40 ms to every click
(TigerVNC's default is 1 ms). The tests read `/proc/net/{tcp,tcp6,udp,udp6}` against each
Xvnc's sockets (what `ss -p` shows): no inet socket at all.

**TigerVNC on Wayland (`wayland-tigervnc`).** The same headless sway as `wayland`, with TigerVNC 1.16's Wayland
server, w0vncserver, as the live view in wayvnc's place: everything else (sway, its directory, grim, the input method,
the sandbox's own RFB client for input, screen sharing through the portal) is the `wayland` backend's. nixpkgs'
w0vncserver does not run there, for two reasons, both fixed by patches in `nix/w0vncserver.nix` (nixpkgs' tigervnc,
patched, built without its viewer and Xvnc; a minute or two):

- It asks the desktop portal first (RemoteDesktop and ScreenCast) and falls back to the compositor's own protocols
  (wlr-screencopy, wlr-virtual-pointer, virtual-keyboard) only when the portal answers without them. With no portal
  on the bus, or no bus, its check threw and it exited at start. Patched: no portal to ask is no portal.
- On the first viewer it makes a virtual keyboard and gives it the seat's keymap, read from the seat's keyboard. A
  headless sway has no input devices, so its seat has no keyboard (`wl_seat.capabilities` 0), and it read a null
  pointer: SIGSEGV in `VirtualKeyboard`'s constructor, right after `create_virtual_keyboard` (gdb). Patched: with no
  keyboard on the seat it gives the virtual keyboard libxkbcommon's default keymap (US: the sandbox sets
  `XKB_DEFAULT_LAYOUT=us`, as wayvnc's `-k us`); sway adds that keyboard to the seat, and w0vncserver then reads the
  keymap back from the seat as it would on a desktop. Its keymap-echo guard (it compares the text) stops a loop.

With the first patch it needs no session bus, and it is given none: `DBUS_SESSION_BUS_ADDRESS` names a socket in the
compositor's directory that is never made. On the machine's bus it would find the owner's portal and could show the
owner's own screen, as a Chromium given that bus could share it (below). Its flags: `-rfbunixpath <socket> -rfbport -1`
(the socket, no TCP port), `-SecurityTypes None` and `-AlwaysShared` as for TigerVNC's Xvnc, `-desktop sandbox` (else
viewers are told `user@host`), `-FrameRate 60`. What it lacks against wayvnc, checked through noVNC in a headless
Chromium (`scripts/liveview-check.ts`):

| through noVNC | `tigervnc` (Xvnc) | `wayland` (wayvnc) | `wayland-tigervnc` (w0vncserver) |
|---|---|---|---|
| click, keys (a, Shift+B, 1, Enter) | yes | yes | yes |
| the live view's typed text with characters no US key has (é, €, ü as keysyms) | typed | dropped | dropped |
| clipboard, viewer → sandbox (a long paste) | yes | yes | no |
| clipboard, sandbox → viewer | yes | yes | no |
| the viewer asking to resize the screen | refused | refused | refused |
| the screen changing size (sway's output) | (no sway) | the viewer follows | the viewer follows |

w0vncserver 1.16 has no clipboard on wlroots at all (no data-control), so the live view's paste of long or many-line
text does nothing there; short one-line text is typed as keys and works for what a US keyboard has. Neither Wayland
server types a keysym that is not on its keymap's keys, so é and € from the live view are lost on both (the
sandbox's own typing sends them through the input method instead). It also draws the pointer into the picture (no
cursor of its own to the viewer), copies each frame through shared memory (no dmabuf), and has no H.264.

**KasmVNC is refused.** `kasmvnc` (KasmVNC 1.5.2, packaged from its upstream Debian build in `nix/kasmvnc.nix`,
pinned by hash) runs in the sandbox code and in the benchmarks, but the manager does not offer it, because the live
view cannot drive it: KasmVNC changed RFB in ways noVNC (the manager's page and dither-chat's live view) does not speak.

- Pointer events are 11 bytes (a 16-bit button mask, x, y, and two 16-bit scroll fields) where RFB's are 6: the
  first mouse move from noVNC desynchronises the client-to-server stream, and the server reads garbage from then on.
- It sends every viewer its own messages 253 and 254 when another viewer joins or leaves; noVNC drops the connection
  on an unknown message, and the manager's page and a sandbox's own input client are two viewers.
- The clipboard goes only through its message 180 (binary clipboard). It drops RFB's ClientCutText, plain and
  extended ("Client sent old cuttext msg, ignoring"), so noVNC's clipboard does nothing.
- With no user in `~/.kasmpasswd` a viewer gets no picture and no input, and nothing is logged; `-DisableBasicAuth`
  is needed even with no security type.

Its own web client speaks all that, but it is served from KasmVNC's built-in HTTP and WebSocket listener, which takes
a TCP port (`-websocketPort`); the bridge carries the Unix socket's RFB only. It also asks STUN servers for its public
address at every start unless given `-publicIP` (the sandbox gives `127.0.0.1`), and the packaging patches its
hardcoded `/usr/bin/xkbcomp`. Its video mode is left without FFmpeg: it looks for `libavformat.so` by walking
`/usr/lib/` and `/usr/lib64` whole at every start, before it answers on its socket (5–18 s on an Ubuntu CI runner),
so the packaging points both at an empty directory.

**What a page sees.** Chromium 155 compared on both, same flags, same machine:

- The same: `navigator.platform` (Linux x86_64), the user agent (Chromium still says X11 in it), client hints, the
  screen (the sandbox's size), device pixel ratio, colour depth, fonts, and the unmasked WebGL renderer (the GPU's,
  through ANGLE on Vulkan). A browser sandbox's sway renders with gles2 on the machine's render node for that: under
  pixman Chromium's GPU process loses WebGL or hangs, so a browser gets pixman only where there is no render node.
  A native app's sway always draws in software (pixman): the app has no render node inside its sandbox and draws in
  software anyway, and the GPU driver is most of what a GPU-backed sway costs (docs/native-sandbox.md).
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

**Screen sharing, and the machine's session bus.** On wayland a browser sandbox's Chromium gets a session bus of its
own (`packages/browser/src/screenshare.ts`), never the machine's. The machine's session bus has the owner's portal
on it, and a Chromium given it (as it was, through the manager's environment) asks that portal for a screen when a
page calls getDisplayMedia: it could share the owner's real screen. A sandbox that shares its screen (Discord's, and
any `Sandbox` with `screenShare`) gets on that bus its own PipeWire, WirePlumber (every device monitor off: no sound
card, camera or Bluetooth of the machine), xdg-desktop-portal and xdg-desktop-portal-wlr, the last told the sway
socket alone with `chooser_type=none` and `output_name=HEADLESS-1`: the sandbox's one output is the only thing it can
share, and the portal asks nothing. Chromium runs with its PipeWire capturer; its own picker still asks (Entire
Screen, then Share, in the live view) unless a flag answers it: `--use-fake-ui-for-media-stream` does in tests, and
it is not used in the product, since it also says yes to every camera and microphone request. The other sandboxes
get only the empty bus. Everything is under `<compositor's directory>/share`, in nothing of the machine's.

On x11 Chromium captures its Xvfb itself, with no portal (`--auto-select-desktop-capture-source=Entire screen`
answers its picker there). An x11 sandbox's Chromium still has the manager's session bus, as before: it uses it at
start (the portal's appearance settings), and its notifications and media keys would reach the machine's desktop.
Moving x11 sandboxes onto a bus of their own too is the next step, left out here so x11 does not change under the
accounts that run on it.

What Discord's Go Live sends is still the device's screen through the bridge when the device shares one
(docs/chat.md, "Video"); only when it does not does the client's own getDisplayMedia reach Chromium, and with it this
portal. Native apps (Signal Desktop, Telegram Desktop) answer the portal's FileChooser, OpenURI and Settings from our
own services on their bus (docs/native-sandbox.md) and have no ScreenCast yet: giving them one means forwarding
`org.freedesktop.portal.ScreenCast` from those services to xdg-desktop-portal-wlr on the same bus, with the PipeWire
remote's descriptor passed back, which the bus code here does not carry yet.

`packages/browser/test/screenshare.test.ts` checks it end to end: a page draws an animated pattern of counters,
shares the screen, and sends it over WebRTC to a second page that decodes every frame (each one must be a counter
the page drew, at the screen's size, at more than 8 fps, under 500 ms median from drawing to decoding); sharing
stops (the portal's stream leaves PipeWire) and starts again; the same for an Electron app (desktopCapturer's
screen) and on x11. It runs under a stand-in for the machine's session bus, with a portal on it, a dbus-monitor
watching it and `XDG_RUNTIME_DIR/bus` pointing at it too: nothing from a wayland sandbox may connect there, and no
ScreenCast may be asked there (a Chromium given that bus, as before, is seen there within a second, so the watch
works). Two wayland sandboxes run at once, and each one's capture decodes as its own page.

**Measured side by side.** `scripts/bench-display.ts` runs one browser sandbox per backend through the same pages
and input and writes JSON; `scripts/bench-display-report.ts` turns that into a page with charts (with
`scripts/bench-native.ts`'s native apps and `scripts/bench-link.ts`'s slow links beside it). On a 16-thread desktop
CPU with a mid-range AMD GPU, 1280×800, five repetitions (backend order alternating, 1-minute load 4–7.7, one x11
repetition at 36), medians:

| | x11 | wayland |
|---|---|---|
| start → live view up / first page ran | 180 / 707 ms | 589 / 1,246 ms (warm starts 360–590 / 810–1,250) |
| idle: CPU, PSS of every process | 3.7%, 188 MB | 3.8%, 225 MB |
| idle: PSS of all but Chromium | 22 MB (Xvfb 16, x11vnc 6) | 54 MB (sway 43, wayvnc 9) |
| live view, full-screen animation: frames/s, server CPU | 39.0, 16% | 58.1, 78% (wayvnc's default `-f 30`: 29.6, 45%) |
| live view, page scrolling: frames/s, bytes/s | 27.8, 1.6 MB/s | 58.7, 5.1 MB/s |
| live view, 720p video: frames/s, server CPU | 19.2, 54% | 28.0, 34% |
| live view, a still page with a viewer: server CPU | 1.4% | 0% (at 30 too) |
| RFB press → page handler / click to photon | 7.2 / 74 ms | 1.0 / 32 ms |
| typing, each backend's own way (35 ms a key) | 28 chars/s | 17 chars/s |
| screen share: frames/s, drawn → decoded, CPU | 25.3, 83 ms, 152% | 26.0, 119 ms, 102% |
| 720p VP9 video in Chromium: dropped, CPU | 0.3%, 60% | 5.0%, 32% |
| WebGL (60 Hz display): frames/s, CPU | 60, 106% | 61, 31% |
| screenshot (import / grim) | 99 ms | 37 ms |
| 5 sandboxes at once: all started, PSS each | 6.3 s, 190 MB | 2.5 s, 207 MB |
| 10 / 20 sandboxes at once | failed (below) | 2.6 s, 204 MB / 6.1 s, 197 MB, 57% idle CPU in all |

So: wayland costs about 30 MB more per browser sandbox (sway on the GPU), starts slower alone and not slower many at
a time, answers input far sooner, and draws GPU work and video with a third to a half of X's CPU (nothing is read back
into Xvfb). Its live view now sends up to 60 frames a second (`-f 60`): twice the frames of wayvnc's default for 1.7
times its CPU while something moves, nothing more while the screen is still. Its screen share is slower to each frame
(PipeWire through the portal) than Chromium reading Xvfb. The x11 runs of 10 and 20 at once failed because x11vnc
could not get System V shared memory (`shmget: No space left on device`): each x11 sandbox holds about 40 segments
while it runs, the kernel allows `kernel.shmmni` (4096 by default) on the whole machine, and segments left by
processes killed without cleaning up count against it too. Wayland sandboxes hold none. wayvnc's `-g` (its GPU
features) changed nothing with ZRLE (58 frames a second at 78% either way), and its Open H.264 still delivers no frame
on that machine: the encoder takes the first frame and never finishes it, wayvnc at 100% of a core. So the sandbox's
wayvnc runs without `-g`; it then never offers H.264, even to noVNC, which asks for it first.

**The live view over a slow link.** `scripts/bench-link.ts` puts a link between a viewer and the live view's
socket, shaped with tc in a network namespace of its own (`scripts/bench-shaper.ts`: netem for delay and loss, tbf
for bandwidth with a 50 ms queue; each link measured before use), and a CPU quota on the display processes alone (a
systemd scope). The viewer asks for what the manager's page (noVNC 1.7) asks for: Tight first after Open H.264, quality
6, compression 2, continuous updates and fences. Both servers answer with Tight; x11vnc waits for each request,
wayvnc takes continuous updates and pushes frames as they come. Three repetitions, medians (frames a second of the
full-screen animation / of the video, then click to photon):

| link | x11 | wayland |
|---|---|---|
| unlimited | 35 / 35 fps, 81 ms | 59 / 28 fps, 8 ms |
| 20 Mbit/s | 20 / 17 fps, 48 ms | 11 / 22 fps, 50 ms |
| 5 Mbit/s | 7.3 / 5.7 fps, 55 ms | 2.8 / 4.1 fps, 193 ms |
| 1 Mbit/s | 2.1 / 1.8 fps, 95 ms | 0.6 / 0.8 fps, 1.2 s |
| 20 ms round trip | 24 / 23 fps, 86 ms | 59 / 28 fps, 29 ms |
| 50 ms | 14 / 14 fps, 147 ms | 59 / 28 fps, 58 ms |
| 150 ms | 11 / 5.7 fps, 198 ms | 52 / 26 fps, 159 ms |
| 5 Mbit/s, 50 ms | 5.5 / 4.1 fps, 147 ms | 2.0 / 2.8 fps, 301 ms |
| 1 Mbit/s, 150 ms | 1.8 / 1.4 fps, 250 ms | 0.4 / 0.6 fps, 1.6 s |
| 20 Mbit/s, 50 ms, 1% loss | 3.9 / 2.9 fps, 147 ms | 1.4 / 1.8 fps, 288 ms |
| display at 50% of a core | 35 / 35 fps, 48 ms | 59 / 28 fps, 8 ms |
| display at 20% of a core | 17 / 14 fps, 49 ms | 25 / 28 fps, 9 ms |

- Delay alone: wayland wins, and by more the farther away. Continuous updates do not wait a round trip per frame, so
  it holds 52–59 frames a second at 150 ms, where x11vnc's request and answer fall to 11.
- Bandwidth: x11 wins wherever the link is the limit. wayvnc's Tight is two and a half to five times the bytes of
  x11vnc's (a still page of text, the first whole screen: 270 KB against 103 KB; the animation about 215 KB a frame
  against 80), as it sends every changed 64×64 tile as JPEG where x11vnc sends flat areas as fills and palettes. At
  5 Mbit/s and below a click on wayland takes 0.2–1.6 s to come back against x11's 0.05–0.25 s. Video, which JPEG
  suits, is the exception at 20 Mbit/s. With ZRLE asked for instead, wayvnc sends the animation at 58 frames a second
  in 0.5 MB/s, even at 5 Mbit/s and 50 ms (x11vnc 12), for more of its CPU (78% of a core); noVNC asks for Tight
  first, so the page gets Tight.
- Loss: TCP's own slowdown (1% loss at 50 ms leaves about 2.3 Mbit/s), so the same as bandwidth: x11 ahead.
- A small CPU: wayland ahead. At 20% of a core x11 draws 17 frames a second and wayland 25, video 14 against 28, and
  a click comes back in 49 ms against 9.
- wayvnc's Open H.264 (with `-g`, asked for first as noVNC does) still sends nothing at any of these.
- The manager's bridge (packages/manager/src/http.ts) now stops reading the VNC socket while the page's WebSocket is
  backed up. Before, it read on regardless: x11vnc never noticed, as it sends only when asked, but wayvnc's output
  piled up in the manager (10 MB at 5 Mbit/s and 50 ms) and at 1 Mbit/s and 150 ms passed Bun's 16 MB limit, past
  which Bun drops what is sent (38 MB in the run), which breaks the RFB stream. Paced, wayvnc sees a full socket and
  sends fewer frames; the frames a second are the same, the stream stays whole and the manager holds at most a few
  hundred KB.

**The Xvnc backends side by side.** The same benchmarks with all five backends, three repetitions (slow links two,
native apps two), backend order rotated, 1-minute load 3–9 on the shared machine, medians. TurboVNC with
`-deferupdate 1`; KasmVNC through a viewer that speaks its RFB, with noVNC's list plus its own WebP where noted.

| | x11 | tigervnc | kasmvnc | turbovnc | wayland |
|---|---|---|---|---|---|
| start → live view up / first page ran (ms) | 282 / 859 | 218 / 798 | 97 / 476 | 210–1,880 / 2,140 (noisy) | 883 / 1,385 |
| idle: PSS of all but Chromium | 22 MB | 19 MB | 19 MB | 15 MB | 54 MB |
| idle: private memory (USS) of the sandbox | 157 MB | 159 MB | 160 MB | 154 MB | 188 MB |
| System V shm segments held | about 42 | 0 | 0 | 0 | 0 |
| animation, ZRLE: frames/s, server CPU | 39.5, 14% | 57.2, 34% | 17.7, 34% | 58.9, 17% | 56.9, 73% |
| animation, Tight: frames/s, bytes/s, server CPU | 33.6, 2.7 MB/s, 26% | 57.2, 4.8 MB/s, 43% | 55.3, 1.7 MB/s, 50% | 59.2, 5.5 MB/s, 116% | 57.7, 12.7 MB/s, 36% |
| scrolling, Tight: frames/s, bytes/s | 30.6, 3.0 MB/s | 55.1, 5.5 MB/s | 55.8, 2.7 MB/s | 59.3, 16 MB/s | 57.7, 14.8 MB/s |
| 720p video, Tight: frames/s, bytes/s | 33, 2.7 MB/s | 39, 2.5 MB/s | 30, 3.7 MB/s | 59, 11.6 MB/s | 28, 3.0 MB/s |
| RFB press → page handler / click to photon | 7.7 / 72 ms | 0.9 / 30 ms | 0.9 / 31 ms | 0.8 / 32 ms | 0.9 / 28 ms |
| typing, 35 ms a key | 28 chars/s | 28 | 28 | 28 | 17 |
| screen share: frames/s, drawn → decoded, CPU | 24, 84 ms, 142% | 24, 69 ms, 153% | 24, 83 ms, 147% | 26, 83 ms, 126% | 27, 119 ms, 109% |
| 720p VP9 in Chromium: dropped, CPU | 0.3%, 63% | 0%, 57% | 0%, 57% | 0%, 53% | 5.3%, 24% |
| WebGL: frames/s, CPU | 60, 92% | 60, 90% | 60, 83% | 60, 80% | 61, 26% |
| screenshot | 99 ms | 99 ms | 87 ms | 89 ms | 34 ms |
| 10 sandboxes at once: started, USS each | — (5: 1.6 s, 139 MB) | 11 s (one run; 5 in 1.0 s), 132 MB | 3.8 s, 131 MB | 3.4 s, 130 MB | 2.0 s, 159 MB |

KasmVNC's own WebP: the animation at 55 frames a second in 1.2 MB/s. At TurboVNC's default 40 ms defer the
animation ran at about 20 frames a second and a click came back in 73 ms. x11 stops at 5 here: five x11 sandboxes
left the machine 31 segments short of its 4096.

Over a slow link, as noVNC asks (Tight first), two repetitions: frames a second of the animation / the video, then
click to photon.

| link | x11 | tigervnc | kasmvnc | turbovnc | wayland |
|---|---|---|---|---|---|
| unlimited | 35 / 32, 49 ms | 56 / 35, 28 ms | 57 / 30, 24 ms | 59 / 30, 17 ms | 55 / 28, 9 ms |
| 5 Mbit/s | 6.9 / 5.1, 55 ms | 8.1 / 6.7, 26 ms | 27.5 / 4.5, 24 ms | 9.4 / 6.3, 20 ms | 2.7 / 4.3, 195 ms |
| 1 Mbit/s | 1.5 / 1.4, 95 ms | 2.0 / 1.2, 26 ms | 5.9 / 1.0, 24 ms | 2.0 / 1.2, 20 ms | 0.6 / 0.6, 1.2 s |
| 50 ms round trip | 17 / 14, 147 ms | 56 / 42, 76 ms | 54 / 30, 76 ms | 58 / 30, 67 ms | 59 / 28, 59 ms |
| 150 ms | 12 / 5.9, 197 ms | 49 / 37, 175 ms | 55 / 30, 174 ms | 55 / 27, 167 ms | 49 / 27, 159 ms |
| 5 Mbit/s, 50 ms | 5.3 / 4.3, 146 ms | 7.6 / 4.9, 76 ms | 27 / 4.6, 73 ms | 7.7 / 5.3, 66 ms | 2.0 / 2.9, 303 ms |
| 1 Mbit/s, 150 ms | 1.6 / 1.2, 247 ms | 1.6 / 0.8, 178 ms | 5.4 / 0.9, 175 ms | 1.6 / 0.8, 167 ms | 0.4 / 0.8, 1.6 s |
| 20 Mbit/s, 50 ms, 1% loss | 3.7 / 3.9, 147 ms | 5.0 / 3.5, 101 ms | 16 / 2.9, 75 ms | 5.3 / 3.1, 68 ms | 1.0 / 2.0, 437 ms |
| display at 20% of a core | 17 / 18, 47 ms | 24 / 25, 27 ms | 13 / 13, 24 ms | 15 / 26, 18 ms | 19 / 28, 10 ms |

The Xvnc servers push changes as they come (like wayvnc) but code flat areas as fills and palettes (like x11vnc), so
they keep wayland's frames on a far link and x11's clicks on a thin one; KasmVNC also lowers its JPEG quality as the
link fills. With ZRLE at 5 Mbit/s and 50 ms TigerVNC sends the animation at 58 frames a second in 0.31 MB/s. Native
apps (Signal Desktop, Telegram Desktop, Haveno) behave the same on every X backend: input reaches each, the display
costs 12–24 MB against 45–78 MB on wayland. On the lab's signed-in test accounts (one read-only run per account and
backend) the live views order the same way: TigerVNC holds 14–25 frames a second through 1 Mbit/s and 150 ms, x11
and wayland under 9.

So `tigervnc` is the pick for browser and native sandboxes alike: wayland's input and frames, x11's memory, no shm,
and the best of both on slow links. wayland stays ahead on GPU work, video in Chromium and screenshots; `turbovnc`
matches TigerVNC's frames for 2–4 times its Tight bytes and more CPU; `kasmvnc` is best on thin links but needs a
viewer noVNC is not.

**TigerVNC's Wayland server beside wayvnc and TigerVNC's Xvnc.** `wayland-tigervnc` measured in one session with
`tigervnc` and `wayland` run again beside it (the table above is an earlier session's): three repetitions (slow links
and native apps two), backend order rotated, 1-minute load 2–9 (two of wayland's slow-link runs at 32, marked busy),
medians. The same benchmarks as above.

| | tigervnc | wayland | wayland-tigervnc |
|---|---|---|---|
| start → live view up / first page ran (ms) | 99 / 503 | 869 / 1,475 | 343 / 826 |
| idle: PSS of all but Chromium | 20 MB (Xvnc) | 61 MB (sway 51, wayvnc 10) | 68 MB (sway 46, w0vncserver 22) |
| System V shm segments held | 0 | 0 | 0 |
| animation, ZRLE: frames/s, server CPU | 58.1, 34% | 57.6, 69% | 57.3, 43% |
| animation, Tight: frames/s, bytes/s, server CPU | 57.8, 4.8 MB/s, 44% | 58.5, 12.7 MB/s, 35% | 57.8, 4.5 MB/s, 53% |
| scrolling, Tight: frames/s, bytes/s | 57.5, 5.5 MB/s | 58.0, 14.8 MB/s | 57.4, 5.6 MB/s |
| 720p video, Tight: frames/s, bytes/s | 31, 2.5 MB/s | 28, 3.0 MB/s | 35, 2.4 MB/s |
| RFB press → page handler / click to photon | 0.8 / 29 ms | 0.9 / 27 ms | 1.0 / 19 ms |
| typing, 35 ms a key | 28 chars/s | 17 | 17 |
| screen share: frames/s, drawn → decoded, CPU | 27, 80 ms, 136% | 27, 111 ms, 106% | 26, 111 ms, 109% |
| 720p VP9 in Chromium: dropped, CPU | 0.3%, 53% | 5.3%, 26% | 3.3%, 28% |
| WebGL: frames/s, CPU | 60, 87% | 61, 27% | 61, 37% |
| screenshot | 91 ms | 33 ms | 42 ms |
| 10 sandboxes at once: started, USS each | 2.4 s, 132 MB | 2.6 s, 159 MB | 3.4 s, 159 MB |

Over a slow link, as noVNC asks (Tight first): frames a second of the animation / the video, then click to photon.

| link | tigervnc | wayland | wayland-tigervnc |
|---|---|---|---|
| unlimited | 48 / 39, 28 ms | 57 / 28, 9 ms | 54 / 35, 19 ms |
| 20 Mbit/s | 32 / 29, 26 ms | 11 / 22, 51 ms | 29 / 28, 18 ms |
| 5 Mbit/s | 8.0 / 6.5, 26 ms | 2.8 / 4.2, 193 ms | 7.2 / 6.9, 17 ms |
| 1 Mbit/s | 2.0 / 1.6, 26 ms | 0.6 / 0.7, 1.2 s | 1.9 / 1.4, 17 ms |
| 50 ms round trip | 50 / 43, 80 ms | 43 / 28, 66 ms | 52 / 39, 68 ms |
| 150 ms | 45 / 33, 183 ms | 50 / 25, 189 ms | 39 / 37, 167 ms |
| 5 Mbit/s, 50 ms | 6.8 / 4.7, 81 ms | 2.0 / 2.8, 302 ms | 6.7 / 5.1, 83 ms |
| 1 Mbit/s, 150 ms | 1.2 / 0.9, 176 ms | 0.4 / 0.6, 1.6 s | 1.3 / 0.8, 174 ms |
| 20 Mbit/s, 50 ms, 1% loss | 4.6 / 3.7, 102 ms | 1.4 / 1.8, 230 ms | 5.1 / 2.7, 81 ms |
| display at 50% of a core | 50 / 34, 27 ms | 39 / 28, 10 ms | 38 / 37, 18 ms |
| display at 20% of a core | 22 / 29, 26 ms | 15 / 25, 11 ms | 15 / 22, 17 ms |

w0vncserver sends what TigerVNC's Xvnc sends: the same encoders, so a still page's first whole screen is 94 KB (Xvnc
95 KB, wayvnc 270 KB) and the animation a third of wayvnc's Tight bytes. On a thin link it keeps TigerVNC's frames
and clicks, two to ten times wayvnc's; on a far one all three hold 40–55 frames a second. It answers a click sooner
than either (19 ms), and with ZRLE costs 43% of a core where wayvnc costs 69%. Where it loses: it reads every frame
into shared memory (no dmabuf), so with sway on the GPU a busy screen costs more (WebGL 37% of a core against 27%,
screenshots 42 ms against 33) and a display held to 20% of a core draws 15 frames a second, as wayvnc does, against
the Xvnc's 22; it holds 22 MB where wayvnc holds 10; and it lacks the clipboard (above). Starting is faster than
wayvnc's, though the screen's start is mostly sway's.

Native apps on sway with w0vncserver (`scripts/bench-native.ts`, config `w0-pixman`) behave as on sway with wayvnc:
input reaches Signal Desktop, Telegram Desktop and Haveno, idle CPU is the app's own, and the display costs 46–78 MB
(sway and w0vncserver; wayvnc's 45–76, Xvnc's 16–23). The first picture came at about the same time as with wayvnc
(Haveno 3.3 s, Signal 16 s, Telegram 5.8 s; these times are noisy, one Signal run on Xvnc took 60 s).

On the lab's signed-in test accounts (`scripts/bench-lab.ts`, two Proton and two Discord test accounts, read-only, one
run each, medians over the four):

| | tigervnc | wayland | wayland-tigervnc |
|---|---|---|---|
| pointer sweep and clicks: frames/s, bytes/s | 10, 0.06 MB/s | 9.1, 0.10 MB/s | 17\*, 0.06 MB/s |
| 5 Mbit/s, 50 ms: frames/s | 15 | 8.5 | 18\* |
| 1 Mbit/s, 150 ms: frames/s, first whole screen | 18, 2.1 s | 2.6, 3.3 s | 29\*, 2.1 s |
| display memory (PSS) | 19–25 MB | 71–108 MB | 58–68 MB |
| account online | 1.0–3.7 s | 1.1–1.6 s | 2.9–4.9 s |

\* w0vncserver draws the pointer into its frames, and the sweep moves it 25 times a second, so part of its frames are
only the pointer moving: count its bytes, which match the Xvnc's, not its frames. wayland's memory here is sway on the
GPU (gles2) with Chromium's GPU buffers; on wayland-tigervnc it is the same sway, so the 10–40 MB between them is
mostly what wayvnc and w0vncserver map of it. The account came online 1–3 s later on wayland-tigervnc in every run;
not looked into (the synthetic start, above, is faster than wayvnc's).

**What the benchmarks leave out.** Read the numbers above with these in mind; the first three are fixed in the
scripts, the rest are open.

- Fixed: an Xvnc's socket appears before the server answers on it (KasmVNC, walking `/usr/lib` for FFmpeg, greeted
  5–18 s late on CI), so a screen counts as started once its live view has said "RFB" (`waitForRfbBanner`), as the
  benchmarks' "live view up" always meant.
- Fixed: PSS splits each shared page among every process that maps it, other programs' Chromiums included (a live
  manager's), so it moves with whatever else runs. The scripts now record USS (pages no other process maps) beside it.
  Neither is the cost of one more sandbox; the scale runs' per-sandbox figure is closer.
- Fixed: `scripts/bench-lab.ts` ran each account on each backend once, in the same order. It now records the machine's
  load at each run and takes `--first-rep` so a later pass goes through the backends in another order.
- Synthetic pages are not apps. The animation, scrolling page, video and WebGL scene are regular and worst-case; an
  app redraws in bursts (a hover, an avatar, a typing dot). The lab run covers two kinds of signed-in browser accounts
  (Proton, Discord), read-only. The native apps (Signal Desktop, Telegram Desktop, Haveno) are measured only on their
  first screen, never signed in. To close: a signed-in Signal Desktop and Telegram Desktop on test accounts in the lab.
- Our viewer is not noVNC. The benchmarks' viewer is a Bun RFB client that counts what arrives and decodes only what
  a measurement reads; frames a second are updates received, not frames drawn, and the cost of decoding JPEG, WebP or
  ZRLE in a browser (on a phone, most of it) is not in them. To close: noVNC in a headless Chromium as the viewer, CPU
  throttled to a phone's, counting its own paints.
- The shaped link is tc on a loopback with a fixed delay and independent random loss: no jitter, reordering,
  Wi-Fi or cellular bursts, and none of the real path's hops (the manager's WebSocket, TLS, the tailnet's WireGuard).
  To close: the same scenes through the manager's live-view WebSocket from another machine, and netem jitter and slot
  models for Wi-Fi and LTE.
- Click to photon ends when the changed pixels reach our viewer's framebuffer: it leaves out the viewer's decode and
  paint and the screen's refresh (16–50 ms more), and the change it waits for is a flat block of colour, cheap to
  encode. To close: the same with noVNC, timed from its input event to the canvas showing the change.
- The machine is shared. Load is taken as a repetition starts, not throughout; a repetition that could not wait for a
  quiet machine is kept and marked busy. To close: sample CPU pressure (`/proc/pressure/cpu`) through each measurement
  and flag the ones it rose in, or pin the benchmark to cores nothing else uses.
- Few repetitions (three synthetic, two slow-link, one or two per account in the lab): the report shows the median and
  the range, not a confidence interval.
- Warm caches: every start after the first reads its programs from the page cache. A first start after a boot or a
  deploy is slower, by seconds for a large program. To close: evict the store paths (`posix_fadvise` DONTNEED, no root
  needed) before a cold repetition.
- The GPU is shared with the desktop and every other Chromium on the machine, so WebGL, video and wayland's
  gles2 numbers move with them. To close: record the GPU's busy share (`gpu_busy_percent` in sysfs) during each run.
- Lab start times are mostly the service's: "online" waits for the account's site to load and sign in. One run per
  account and backend (Proton B on tigervnc online in 11.6 s against 3.7 s on x11) says little about the backend.
- One screen size (1280×800); a phone viewer scaling it down is not measured.
- KasmVNC is measured only through its RFB on the Unix socket with our viewer speaking its pointer format: its own
  web client's WebP, adaptive quality and UDP transport, which is how its users get it, are not.
- w0vncserver draws the pointer into its frames (and with it sway draws it into the output, so grim's pictures have
  it too). The scenes never move the pointer while measuring, so the cost of sending a moving pointer as picture,
  where the other servers send a cursor shape once, is not measured. The native apps' "first picture" once took the
  lone pointer on a black screen for the app's first frame; it now also needs the screen to be more than nearly black.
- `wayland-tigervnc` runs a TigerVNC we patch and build (nix/w0vncserver.nix); the others run nixpkgs' or upstream's
  builds as shipped.

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

`packages/browser/test/wayland.test.ts` covers the wayland backends: its parts on their own (the key names, text split
into keys and input-method runs, the Wayland and sway IPC wire, the RFB handshake against a stand-in server, the
config and flags), then a real headless sway and wayvnc (RFB on the socket and nothing else, no TCP or abstract
socket, the seat's pointer and keyboard, grim's PNG), then Chromium on it: a click, Shift-held capitals, é, € and an
emoji typed into a field arrive as trusted input with the right `code`s, and the page has a fine pointer and hover.
`packages/sandbox/test/sandbox-wayland.test.ts` runs a native app on it and checks it sees only `wayland-0`, no X.
Both run the real-sway parts twice, with wayvnc and with w0vncserver (`wayland-tigervnc`, which must also have no
session bus to reach), and skip without sway, grim and that server (and Chromium for the last part), as on CI's
runners outside the `nix` job. Both check the
compositor's renderer: gles2 where there is a render node for a browser, pixman for a native app.
`test/liveview-pace.test.ts` checks the live view's pacing: a stand-in VNC server sends 64 MB to a page that reads
nothing at first; it is held back meanwhile, and every byte arrives in order once the page reads.
