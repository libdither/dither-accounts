# The `browser` interface: an account's own browser, driven like a person drives it

Some jobs on a site are too small or too rare for a kind to have an operation for them, such as putting
something in a cart, looking at a page, or filling in one form. For those, a browser kind can lend its signed-in
browser through the `browser` interface (`packages/interfaces/src/browser.ts`). An app or agent then opens a tab
on the account's site, reads it, and clicks and types in it, as the owner would in the live view.

It is offered today by the extension-only browser kinds on `statements-common`: `amazon`, `venmo` and `schwab`, and
the general `site` kind ([site.md](site.md)), whose whole use it is (`extractors/statements-common/src/browser-ops.ts`,
plus `extension/browser.js` appended to their driver). Another
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

| | `x11` (the default) | `tigervnc`, `kasmvnc` | `wayland`, `wayland-tigervnc` |
|---|---|---|---|
| screen | Xvfb on a free display number (`:80`–`:89`, `:100`–`:159`; Discord `:91`–`:99`) | an Xvnc on a free display number from the same ranges: X server and VNC server in one process | a headless sway of the sandbox's own; its sockets in `<account>/wl` (0700), or in `$XDG_RUNTIME_DIR/dither-wl/<hash>` when the account's path leaves no room for sway's socket names; no display number, nothing in /tmp |
| live view | x11vnc on the socket | the same Xvnc, on the socket (`-rfbunixpath`), with no TCP port (`-rfbport -1`) | wayvnc (`wayland`) or TigerVNC's w0vncserver (`wayland-tigervnc`) on the same socket (no TCP or UDP port, no abstract socket) |
| input | xdotool | xdotool | an RFB client of the sandbox's own on that socket: the live view's server turns it into the seat's virtual pointer and keyboard |
| text no US key makes (é, €, emoji) | xdotool's keysyms, each character first put on a key of its own for the screen's life (xmodmap): bound and unbound around each press, as xdotool does alone, an app can miss it | the same | an input method (input-method-v2 → the field's text-input-v3), as a person with an IME types it |
| picture | ImageMagick's `import` | ImageMagick's `import` | grim |
| the sandbox's own session (below) | in `<account>/xrt` (0700), or `$XDG_RUNTIME_DIR/dither-x/<hash>` when the account's path leaves no room for its sockets | the same | in the compositor's directory |
| apps | `DISPLAY` | `DISPLAY` | Chromium `--ozone-platform=wayland`; native apps get only the compositor's socket, as `<run>/wayland-0`, with Qt, GTK, SDL and Electron told to use it, and no X socket at all |
| built from | nixpkgs | `tigervnc`: nixpkgs; `kasmvnc`: a fork (below) | sway, wayvnc, grim: nixpkgs; w0vncserver: a fork (below) |

**Choosing.** The default for every account is, first, the one picked on the manager's page (**Screens**, at the
foot of the home page: `PUT /api/display` with `{ "default": "<backend>" }`, or `null` to go back), then the
manager's `display_backend` (`--display-backend`, `DITHER_ACCOUNTS_DISPLAY_BACKEND`, or config.toml), then `x11`:
`x11`, `tigervnc`, `kasmvnc`, `wayland` or `wayland-tigervnc`. The page's pick is kept in the manager's database, so
it outlives a restart, and it wins over config.toml until **config.toml's** is picked again. Changing it restarts the
running accounts that follow it, one at a time per kind (docs/supervisor.md). An account's config can name its own,
`displayBackend`: its pane's **Screen**, `bun packages/manager/src/cli.ts display <account> tigervnc` (or `default` to
follow the manager), or `{ "settings": { "displayBackend": "tigervnc" } }` in a PATCH of `/api/accounts/<id>`; its
extractor restarts to take it. The extractor gets the result as `DITHER_DISPLAY_BACKEND`, and the account's detail
shows it (`process.displayBackend`). A manager that adopts extractors started with another backend restarts them one
at a time, as it does for changed code (docs/supervisor.md). Only kinds with a screen take part: their manifest says
`screen: true` (Telegram's only when its Desktop app is on). Any other kind (mail, calendar, signal-cli, the feeds)
answers 400 to a `displayBackend`, gets no `DITHER_DISPLAY_BACKEND`, shows `process.displayBackend: null`, has no
**Screen**, and is never restarted when the default changes. Haveno follows it too: JavaFX draws only through X, so
on wayland it gets an Xwayland of its own inside its sandbox (xwayland-satellite: docs/native-sandbox.md).

**Only one that can run here.** The page's pickers offer each backend with whether it can run on this machine now
(`/api/state` `display.backends[].availability`, with `why`): `ready`; `building` (its programs are being built);
`missing` (they could not be built, or, where the manager prepares nothing, are not on PATH: `why` names them); or,
for one built from a fork, `unbuilt` (its servers are built the first time it is picked, nix/README.md). The page
offers `building` and `missing` ones disabled, with the reason, and `unbuilt` ones as "built when picked". A pick of
any but a `ready` one, as the default or an account's own, is refused with 409 and changes nothing; picking an
`unbuilt` one starts its build, and it can be picked once that is done. Going back (config.toml's, the manager's
default) is never refused.

**The backends are a list.** `packages/spec/src/display.ts` names them (each with its protocol, X or Wayland, the
label its log lines and the page use, and `experimental: 'fork'` with a note for one built from a fork);
`packages/browser/src/screen.ts` maps each to its `Screen` class, and everything else asks the `Screen` (`protocol`,
`chromiumFlags()`, `adjustPrefs()`, `needsOwnBus`, `runtimeDir`, `describe()`, `health()`), never which class it is.
Within a class, what differs between backends is one record: `X_SERVERS` (Xvfb or an Xvnc, and the Xvnc's own flags)
and `WAYLAND_SERVERS` (wayvnc or w0vncserver: program, flags, environment, files). A new backend is an entry in the
list and in one of those, and its programs in `nix/bins.json` and `BACKEND_BINS` (`packages/browser/src/bins.ts`;
nix/README.md).

**Experimental: built from a fork.** `kasmvnc` and `wayland-tigervnc` run a VNC server built from a fork this project
keeps ([zyansheep/KasmVNC](https://github.com/zyansheep/KasmVNC),
[zyansheep/tigervnc](https://github.com/zyansheep/tigervnc)): upstream's latest stable release with our commits on
top, rebuilt, smoke-tested and released by the fork's own CI, and brought here by a daily pull request
(nix/README.md, "Forks"). They are marked experimental, and the page says "Experimental fork" beside them, because
what runs is not a build any distribution ships or upstream supports: our patches carry the risk, a new upstream
release reaches them only once the fork's rebase and smoke test pass, and they have had far less use than x11,
tigervnc and wayland.

**Why sway, not cage.** cage 0.3 as nixpkgs builds it always starts Xwayland, which takes a global X display number
and an abstract socket, the two things this backend is for getting rid of. It also has no IPC (to close a window as a
window manager does, or to know the output and seat are ready), needs another tool to size its output, and exits when
its one app does. sway with `xwayland disable` listens on its Wayland socket and its IPC socket and nothing else.

**The Xvnc backends.** `tigervnc` (TigerVNC's Xvnc, nixpkgs `tigervnc`) and `kasmvnc` (KasmVNC's, `Xkasmvnc` from the
fork) are X servers with the VNC server inside: to an app they are an X display like Xvfb, so everything x11 does
works the same way on them (xdotool, `import`, the clipboard through xclip both ways, X-only apps such as Haveno,
display picking and its locks, Chromium capturing the screen for a share, a takeover after a hard kill), and the
tests run each of those on each Xvnc (`packages/browser/test/xvnc.test.ts`,
`packages/sandbox/test/sandbox-xvnc.test.ts`, `screenshare.test.ts`). What changes is the live view: no x11vnc reading
the screen back through System V shared memory, so an Xvnc sandbox holds no shm segment (an x11 one about 42, from a
machine-wide limit of 4096), and one process instead of two. Each runs with `-nolisten tcp`, no security type (the
socket is the account's, 0700, and itself 0600), always shared (the manager's view and a sandbox's own client at
once), `-AcceptSetDesktopSize=0` (the sandbox sets the screen's size, not a viewer), and `HOME` in
`<account>/xvnc-home`, where it keeps what it writes. A screen counts as started once its live view has said "RFB"
on the socket, not when the socket appears. The tests read `/proc/net/{tcp,tcp6,udp,udp6}` against each Xvnc's
sockets (what `ss -p` shows): no inet socket at all.

KasmVNC needs two more flags: `-DisableBasicAuth` (with no user in `~/.kasmpasswd` a viewer gets no picture and no
input, and nothing is logged, even with no security type) and `-publicIP 127.0.0.1` (else it asks STUN servers for
its public address at every start). Its web client and its HTTP and WebSocket listener are not built: the manager's
noVNC is the viewer, over the Unix socket. KasmVNC changed RFB in ways noVNC does not speak (an 11-byte pointer event
where RFB's is 6, its own messages 253 and 254 to every viewer when another joins or leaves, the clipboard only
through its message 180); the fork speaks standard RFB to any client that announces neither of KasmVNC's own
pseudo-encodings (disconnect notify, direct mouse), which its own web client always sends. So noVNC and the sandbox's
own clients get 6-byte pointer events, no 253 or 254, and the clipboard as ClientCutText and ServerCutText (latin-1)
or, for a client that announces the extended clipboard as noVNC does, as UTF-8 that way (€ and emoji both ways), and
nothing on our side knows KasmVNC is different. The fork also opens FFmpeg's libraries by name instead of walking
`/usr/lib` at every start (5–18 s before it answered on CI), and FFmpeg is left out of the build, so its video modes
are off.

**TigerVNC on Wayland (`wayland-tigervnc`).** The same headless sway as `wayland`, with TigerVNC's Wayland server,
w0vncserver, as the live view in wayvnc's place: everything else (sway, its directory, grim, the input method, the
sandbox's own RFB client for input, screen sharing through the portal) is the `wayland` backend's. The released
w0vncserver does not run there; the fork carries upstream's unreleased fixes (it no longer exits when there is no
desktop portal to ask, and it has a clipboard on wlroots) and our own for a headless seat (it read the seat's
keyboard's keymap, and a headless sway has no keyboard: a SIGSEGV at the first viewer; it now gives its virtual
keyboard the default keymap, US, as the sandbox sets `XKB_DEFAULT_LAYOUT=us`) and for its clipboard (it kept one
offer for the clipboard and the primary selection together, so a browser's copy, which sets both at once, cancelled
its own read and reached no viewer). It needs no session bus and is given
none: `DBUS_SESSION_BUS_ADDRESS` names a socket in the compositor's directory that is never made. On the machine's bus
it would find the owner's portal and could show the owner's own screen, as a Chromium given that bus could share it
(below). Its flags: `-rfbunixpath <socket> -rfbport -1`, `-SecurityTypes None` and `-AlwaysShared` as for the Xvnc,
`-desktop sandbox` (else viewers are told `user@host`), `-FrameRate 60`, and `-SendPrimary=0`: viewers get what a
page or app copies, not every stretch of text selected in the sandbox (the live view wants the clipboard, and a
selection would reach every viewer each time it changed). It draws the pointer into the picture (no
cursor of its own to the viewer), copies each frame through shared memory (no dmabuf), and has no H.264.

**The live view through noVNC**, as the manager's page drives it (`scripts/liveview-check.ts`: the repo's noVNC in a
headless Chromium, through a WebSocket bridged to a sandbox's socket as the manager bridges it):

| through noVNC | `x11` | `tigervnc` | `kasmvnc` | `wayland` | `wayland-tigervnc` |
|---|---|---|---|---|---|
| click, keys (a, Shift+B, 1, Enter) | yes | yes | yes | yes | yes |
| typed text with characters no US key has (é, €, ü as keysyms) | typed | typed | typed | é, ü (no €) | dropped |
| clipboard, viewer → sandbox (with € and é) | no | yes | yes | yes | yes |
| clipboard, sandbox → viewer (with €, é and an emoji) | no | yes | yes | yes | yes |
| the viewer asking to resize the screen | refused | refused | refused | refused | refused |
| the screen changing size (sway's output) | (no sway) | (no sway) | (no sway) | the viewer follows | the viewer follows |

A Wayland server types only keysyms on its keymap's keys, so what the live view types beyond them is lost there (the
sandbox's own typing sends any text through the input method instead).

**What a page sees.** Chromium 155 compared on both, same flags, same machine:

- The same: `navigator.platform` (Linux x86_64), the user agent (Chromium still says X11 in it), client hints, the
  screen (the sandbox's size), device pixel ratio, colour depth, fonts, and the unmasked WebGL renderer (the GPU's,
  through ANGLE on Vulkan). A browser sandbox's sway renders with gles2 on the machine's render node for that: under
  pixman Chromium's GPU process loses WebGL or hangs, so a browser gets pixman only where there is no render node,
  or where a gles2 sway failed to start; Chromium's GPU flags follow the renderer sway really runs with
  (`Screen.chromiumFlags`), so after that fallback it draws in software (SwiftShader) too.
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
a dialog does. That is decided once per window as it opens, one window at a time, so two that open together get one
tiled and one floating, never both floating: a sway `for_window` rule would run again on every title change (a chat's
unread count) and float the main window too. Both sway IPC connections, the one that watches windows opening and the
one requests and commands go on, are opened again when they close (logged), until the screen stops; every IPC
request has a deadline (5 s), past which it fails and its connection is closed. While the main one is being made
again (it counts as back once sway answers on it), `health()` says so and a request waits for it.

**When something dies.** wayvnc is watched: when it exits, the screen says so (`health()`: "wayvnc exited (SIGKILL);
starting it again"), the extractor's status shows its display layer failed with that note, and it is started again
(after 0.5 s, doubling to 30 s with each try; the wait starts over only once one has stayed up 30 s, so a server
that dies soon after each start is not restarted twice a second for good), the sandbox's own RFB client reconnects
and the seat's pointer and keyboard come back; clicks and keys sent meanwhile wait for it (up to 15 s) instead of
failing at once. A try whose reconnect fails ends the server it started before the next one. x11vnc is kept the same
way on x11. Stopping a sandbox ends every process even when its screen fails to stop, and removes the screen's files
only after they are gone (sway, PipeWire and WirePlumber write in the compositor's directory until then). The renderer: a browser's sway uses gles2 only when this user can open the render node
(read and write on `/dev/dri/renderD*`), and if sway still fails to start on it, it starts once more with pixman (a
warning says so). Screen sharing: if PipeWire, WirePlumber or the portals fail to start, that is logged ("screen
sharing is off for this run") and the sandbox starts with its own empty bus and no capture, rather than not at all.

**The runtime directory fallback.** Every directory level the compositor's place is made under, from the runtime
directory (or /tmp) down, is checked before anything goes in it: made 0700 if missing, closed if it is ours and open,
and refused (the screen does not start) when it is a symlink, not a directory, or another user's. A level made first
by someone else in /tmp can neither see the sockets nor point them elsewhere.

**Typing in the live view.** A person's keys in the live view reach wayvnc as keysyms, which it types on its own
keymap: `us-altgr-intl` (US, with the rest of Latin on AltGr and no dead keys). With plain `us`, é, ß, £, ñ, ü and €
were dropped; now they arrive, and US keys are where they were. Still dropped: anything on no key of that keymap,
which is emoji, CJK and most non-Latin scripts. Typing them from the live view needs the viewer's own input method
to send text, which RFB has no message for; the extractor's own typing (the API's `type`) does not have this gap,
since it goes through the input method.

**A session of its own, never the machine's.** Every browser sandbox's Chromium, on every backend, gets a session
of its own (`packages/browser/src/screenshare.ts`): a runtime directory of its own (`XDG_RUNTIME_DIR`, 0700, made
fresh at start and removed at stop: the screen's `runtimeDir`), a session bus of its own there with nothing on it (a
dbus-daemon on `<runtime>/share/bus`), an address for the system bus where nothing is, and an audio server of its own
(a PulseAudio on `<runtime>/share/pulse/native`, given as `PULSE_SERVER`, with a silent speaker and microphone: null
sink and source, no sound card, no shared memory, no server started on demand). `PIPEWIRE_REMOTE` is unset. The
screen's own servers (Xvfb, x11vnc, an Xvnc, sway, the live view's) and its tools (xdotool, xmodmap, import, grim)
are given the same runtime directory and no bus or audio server at all (`noHostSession` in
`packages/browser/src/bins.ts`). The native-app sandboxes use the same for everything they start outside their app's
bubblewrap (docs/native-sandbox.md, "the machine's session").

That is what keeps the owner's desktop out of reach. The machine's session bus has the owner's portal on it, and a
Chromium given it asks that portal for a screen when a page calls getDisplayMedia: it could share the owner's real
screen; its notifications would show on the owner's desktop, and its media keys reach the owner's players. The
machine's audio server has the owner's speakers and microphone: a page's sound would play in the owner's room, and a
page with the microphone allowed could hear it. And without an audio server of its own, Chromium falls back to ALSA,
which opens the machine's sound cards directly (`/dev/snd` is open to the user signed in at the seat): hence a silent
one rather than none. Web Audio runs on its clock as on any desktop, so Discord's call bridge, which mixes the call in
the page and sends it to the device (docs/chat.md, "In a call"), works as before; the call's sound never played in the
sandbox anyway. Cookies do not depend on the session bus (the profile runs on `--password-store=basic` and
`--use-mock-keychain`), so moving a running account onto its own session signs nothing out. A page's notifications no
longer reach the owner's desktop: there is no notification server on the sandbox's bus, as on wayland before.

Until this, an x11, tigervnc or kasmvnc sandbox's Chromium ran with the manager's environment: the machine's session
bus, system bus, runtime directory and audio server. On wayland it had its own session bus already, but still the
machine's runtime directory, system bus and audio server.

**Screen sharing.** On wayland a sandbox that shares its screen (Discord's, and any `Sandbox` with `screenShare`) gets
on its bus its own PipeWire, WirePlumber (every device monitor off: no sound card, camera or Bluetooth of the
machine), xdg-desktop-portal and xdg-desktop-portal-wlr, the last told the sway socket alone with `chooser_type=none`
and `output_name=HEADLESS-1`: the sandbox's one output is the only thing it can share, and the portal asks nothing.
Chromium runs with its PipeWire capturer; its own picker still asks (Entire Screen, then Share, in the live view)
unless a flag answers it: `--use-fake-ui-for-media-stream` does in tests, and it is not used in the product, since it
also says yes to every camera and microphone request. The other sandboxes get only the empty bus and the audio
server. Everything is under `<compositor's directory>/share`, in nothing of the machine's.

On x11 Chromium captures its X server itself, with no portal (`--auto-select-desktop-capture-source=Entire screen`
answers its picker there).

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
works). Two wayland sandboxes run at once, and each one's capture decodes as its own page. On every X backend, too,
nothing reaches the stand-in bus.

`packages/browser/test/host-session.test.ts` checks the rest on every backend: under a stand-in for the machine's
runtime directory, session and system bus, PulseAudio and PipeWire (sockets that note who connects), a sandbox's page
plays a tone and opens the microphone. The tone is a stream on the sandbox's own audio server, the microphone and
speaker the page sees are its silent ones, the screen's servers were given none of the stand-in's addresses, the
runtime directory is 0700 and gone after the stop, and nothing connects to any stand-in; a Chromium given the
stand-in's environment, as an X sandbox's was, is seen there within seconds.

**What the benchmarks found.** The numbers, how they were taken and what they leave out are in
[benchmarks/2026-11-25-display-backends.md](benchmarks/2026-11-25-display-backends.md); the scripts are
`scripts/bench-display.ts`, `bench-link.ts`, `bench-native.ts` and `bench-lab.ts`, and `scripts/bench-tables.ts`
makes that page's tables from their JSON, kept beside it (through `scripts/bench-scrub.ts`, which leaves out what
would describe the machine). What holds across every round:

- **Bytes on a thin link.** The Xvnc servers and w0vncserver send flat areas as fills and palettes and push changes
  as they come: a still page of text is about 95 KB to a new viewer, where wayvnc sends 270 KB (every changed tile as
  JPEG). So below about 20 Mbit/s they keep several times wayvnc's frames and answer a click in tens of
  milliseconds where wayvnc takes 0.2–1.6 s. KasmVNC goes further (53 KB for that page, and it lowers its JPEG
  quality as the link fills): at 5 Mbit/s it draws the animation at 27 frames a second where TigerVNC draws 7. x11vnc is as frugal but waits a round trip for each frame, so a far link
  costs it frames; wayvnc and the Xvnc servers are not held back by distance.
- **Shared memory segments.** x11vnc reads Xvfb's screen through System V shared memory, about 40 segments for each
  x11 sandbox while it runs, from a machine-wide limit (`kernel.shmmni`, 4096 by default) that processes killed
  without cleaning up also use. Every other backend holds none, so only x11 can run a machine out of them.
- **Memory.** An Xvnc costs 20–25 MB beside Chromium (Xvfb and x11vnc together a little more); sway with wayvnc or
  w0vncserver 45–70 MB, the upper end with sway on the GPU. Per browser sandbox, many at once, that is about 130 MB
  on an Xvnc against about 160 MB on sway.
- **Input.** A click from the live view reaches the page within a millisecond and shows in the viewer 20–30 ms later
  on every backend but x11, where x11vnc takes 8–9 ms to pass it on and the change 70–80 ms to come back.
- **Where Wayland is ahead.** With sway on the GPU, WebGL, video in Chromium and screenshots cost a third to a half
  of what they cost on X (nothing is read back into an X server).

What the measurements changed in the code: wayvnc sends up to 60 frames a second (`-f 60`; its default 30 gave half
the frames for 0.6 of the CPU while something moves, the same while nothing does), and runs without `-g` (its GPU
features changed nothing, and its Open H.264 delivered no frame at all, so it never offers H.264, even to noVNC,
which asks for it first). The manager's live-view bridge (packages/manager/src/http.ts) stops reading the VNC socket
while the page's WebSocket is backed up: a server that pushes frames as they come (wayvnc, the Xvnc servers,
w0vncserver) then sees a full socket and sends fewer, instead of piling them up in the manager (10 MB at 5 Mbit/s and
50 ms; past Bun's 16 MB limit what is sent is dropped, which breaks the RFB stream).

**Programs.** Every program a screen or a sandbox starts (Xvfb, x11vnc, xdotool, ImageMagick; sway, wayvnc, grim;
dbus, PipeWire, WirePlumber, the portals; bubblewrap, pasta, xwayland-satellite) and Chromium come from the repo's
one pinned nixpkgs, built ahead of time: the manager builds them at its start into `<data>/bins` (`prepare_bins`, on
by default, tried again while it fails) and gives extractors of a kind with a screen that directory as
`DITHER_BINS`; they start once it is ready. The servers built from forks (KasmVNC, w0vncserver) are a second build,
`<data>/bins-forks`, made after the first and only once one of their backends is in use; an account on one gets
both (`DITHER_BINS` is a list, `:` between) and waits for both, and that build failing leaves the others as they
were (nix/README.md). CI's tests run the same Chromium. An extractor never runs `nix build`.
Without it a program is looked for in its `*_BIN` override and on PATH, and one found nowhere fails the start at
once, saying how to prepare it (nix/README.md). The native apps (Signal Desktop, Telegram Desktop, Haveno) are the
machine's own install, not pinned (nix/README.md "What is not pinned").

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
config and flags, the runtime directory checks against a hostile parent, a render node it cannot open, an IPC
request nobody answers), then a real headless sway and wayvnc (RFB on the socket and nothing else, no TCP or abstract
socket, the seat's pointer and keyboard, grim's PNG; two windows opening together, one tiled and one floating; wayvnc
killed, its health down meanwhile, keys sent then still arriving, and a click after; sway stopped past a request's
deadline, its IPC down meanwhile, and fit working once it answers again; é ß £ € ñ typed as a viewer's
keysyms; screen sharing whose PipeWire fails, run with the bus alone), then Chromium on it: a click, Shift-held capitals, é, € and an
emoji typed into a field arrive as trusted input with the right `code`s, and the page has a fine pointer and hover.
`packages/sandbox/test/sandbox-wayland.test.ts` runs a native app on it and checks it sees only `wayland-0`, no X.
Both run the real-sway parts twice, with wayvnc and with w0vncserver (`wayland-tigervnc`, which must also have no
session bus to reach), and skip without sway, grim and that server (and Chromium for the last part), as on CI's
runners outside the `nix` job. Both check the
compositor's renderer: gles2 where there is a render node for a browser, pixman for a native app.
`test/liveview-pace.test.ts` checks the live view's pacing: a stand-in VNC server sends 64 MB to a page that reads
nothing at first; it is held back meanwhile, and every byte arrives in order once the page reads.
