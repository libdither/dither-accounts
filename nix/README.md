# One pinned nixpkgs for the sandboxes' programs

Every program a screen or a sandbox starts (Xvfb, x11vnc, xdotool, ImageMagick; sway, wayvnc, grim; dbus, PipeWire,
WirePlumber, the portals; bubblewrap, pasta, xwayland-satellite) and Chromium come from one nixpkgs revision, the same
in CI and at run time, built ahead of time. An extractor never runs `nix build`: it would block its event loop, and it would get
whatever nixpkgs the machine's registry says that day.

| file | |
|---|---|
| `pin.json` | the nixpkgs revision and its tarball's hash |
| `bins.json` | the attributes built: `run`, what the sandboxes start (Chromium among them); `test`, what only the tests start (Electron, xev, wev) |
| `overlay.nix` | this repo's additions: `dither-bins` and `dither-test-bins` (below), and any program nixpkgs lacks or that is built differently here |
| `default.nix` | the pinned nixpkgs with the overlay |

## How a program is found

`dither-bins` is a directory with one link per attribute in `bins.json`'s `run` list (`sway-unwrapped`,
`xorg.xev`, …), each to that package's store path. One out-link to it is a GC root for all of them, so a garbage
collection never takes a program a sandbox is about to start.

- **The manager** builds it at its start: `nix-build <repo>/nix -A dither-bins -o <data>/bins`
  (`packages/manager/src/prepare.ts`, `prepare_bins` in config.toml, on by default). It runs beside everything else,
  so the manager answers meanwhile; extractors of a kind with a screen wait for it, then get `DITHER_BINS=<data>/bins`
  (docs/supervisor.md). A failed build keeps the last good out-link (those kinds run on it) and is tried again in
  the background, 30 s later, then twice as long each time, up to 30 min, until one succeeds (`KeptBins`). With no
  earlier out-link those kinds wait until then, and the manager's page shows a banner while it fails. A machine
  with no `nix-build` skips it.
- **An extractor** resolves a program with `resolveBin` (`packages/browser/src/bins.ts`): its `*_BIN` override
  (`SWAY_BIN`, `WAYVNC_BIN`, `CHROMIUM_BIN`, …), then `$DITHER_BINS/<attr>/bin/<name>`, then PATH. A program with
  `pinned: true` found nowhere fails at once with what to run. Nothing is ever built there: `resolveBin` is
  synchronous, and a build would block the extractor's event loop for minutes.
- **CI's `nix` job** points `NIX_PATH` and the `nixpkgs` registry entry at the same revision, installs the few
  programs the tests want on PATH from it (`nix-env -f ./nix -iA …`), then
  `bun scripts/prepare-bins.ts --out /tmp/dither-bins --tests` and `DITHER_BINS=/tmp/dither-bins`.
- **Running the tests that need it yourself:**

  ```
  bun scripts/prepare-bins.ts --out <dir> --tests
  DITHER_BINS=<dir> bun test packages/browser packages/sandbox
  ```

  Delete `<dir>` when done; it is a GC root until then. The tests that run a real browser on X (`test/*-browser.test.ts`,
  `extractors/*/test/browser.test.ts` and the like) need it too, and without it skip saying so (`browserBins` in
  test/needs.ts).

## What is not pinned

The native apps a sandbox runs, Signal Desktop, Telegram Desktop and Haveno, are the machine's own install: their
`*_BIN` override (`SIGNAL_DESKTOP_BIN`, `TELEGRAM_DESKTOP_BIN`, `HAVENO_DESKTOP_BIN`) or PATH, and an error at once
when neither has them (never a `nix build`). Why not from this pin: Signal Desktop refuses to run once its build is
about 90 days old, so it must follow the machine's updates, not a pin moved by hand; Telegram Desktop's profile is
written for the version installed (`TDESKTOP_VERSION` in extractors/telegram/src/tdata.ts, checked against the
install by its profile.test.ts), which is the machine's; and nixpkgs has no Haveno at all (the machine has its own
launcher of the signed jar). CI's tests run stand-ins of them, never the apps.

## Changing it

- **Moving the pin:** set `rev` in `pin.json` to a nixos-unstable commit, and `sha256` to
  `nix-prefetch-url --unpack https://github.com/NixOS/nixpkgs/archive/<rev>.tar.gz`. Run the tests that need Nix
  (above) before pushing; CI's `nix` job runs them on the new pin. Besides, by hand:
  - **Never move it back past a Chromium the accounts have run.** Chromium will not open a profile a newer one
    wrote, and every account's sign-in is its profile. Compare `nix-instantiate --eval -E '(import ./nix {}).chromium.version'`
    on both revisions.
  - **xwayland-satellite's log line.** The native sandbox starts an X app on the wayland backend only once satellite
    has logged `Connected to Xwayland on` (`SATELLITE_READY` in packages/sandbox/src/sandbox.ts, as 0.8.3 writes it):
    a window made before that never got a Wayland window. A new satellite that words it otherwise makes every such
    app fail to start after 20 s ("did not connect to its Xwayland"). Check the line is still in its source
    (`grep -rn 'Connected to Xwayland' $(nix-build ./nix -A xwayland-satellite.src)`), and
    `packages/sandbox/test/sandbox-satellite.test.ts` passes.
- **A program from nixpkgs:** its attribute in `bins.json`, and a `BinSpec` with `nix: '<attr>'` and `pinned: true`
  where the code starts it (`DISPLAY_BINS`, `SHARE_BINS`, packages/sandbox's `BINS`, test/needs.ts's `TEST_BINS`).
  `packages/browser/test/bins.test.ts` checks the two lists match.
- **A program nixpkgs lacks or that is built here** (a patched VNC server, say): `nix/<name>.nix`, an attribute in
  `overlay.nix` (`<name> = final.callPackage ./<name>.nix { };`), then the same two steps. It is built in the same
  `nix-build`, with the same GC root.
- **A display backend:** its entry in `packages/spec/src/display.ts` (`BACKENDS`: name, protocol, label), its
  `Screen` class in `packages/browser/src/screen.ts`'s `SCREENS`, and its programs as above (docs/browser.md, "Display
  backends").
