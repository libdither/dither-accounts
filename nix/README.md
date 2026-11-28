# One pinned nixpkgs for the sandboxes' programs

Every program a screen or a sandbox starts (Xvfb, x11vnc, xdotool, ImageMagick; the Xvnc servers; sway, wayvnc, grim;
dbus, PipeWire, WirePlumber, the portals; bubblewrap, pasta, xwayland-satellite) and Chromium come from one nixpkgs
revision, the same in CI and at run time, built ahead of time. An extractor never runs `nix build`: it would block its
event loop, and it would get whatever nixpkgs the machine's registry says that day.

| file | |
|---|---|
| `pin.json` | the nixpkgs revision and its tarball's hash |
| `bins.json` | the attributes built: `run`, what the sandboxes start (Chromium among them); `forks`, the servers built from forks this project keeps (KasmVNC, w0vncserver); `test`, what only the tests start (Electron, xev, wev, xclip, continuwuity) |
| `overlay.nix` | this repo's additions: `dither-bins`, `dither-bins-forks` and `dither-test-bins` (below), and any program nixpkgs lacks or that is built differently here |
| `w0vncserver.nix`, `kasmvnc.nix` | the two VNC servers built from forks (below), each its fork's release file as it is |
| `default.nix` | the pinned nixpkgs with the overlay |

## How a program is found

`dither-bins` is a directory with one link per attribute in `bins.json`'s `run` list (`sway-unwrapped`,
`xorg.xev`, …), each to that package's store path. One out-link to it is a GC root for all of them, so a garbage
collection never takes a program a sandbox is about to start. `dither-bins-forks` is the same for `bins.json`'s
`forks` list: the two servers built from forks (below), a build of its own because where no binary cache has them
they build from source for minutes, and one that fails to build must leave every other backend as it was.

- **The manager** builds it at its start: `nix-build <repo>/nix -A dither-bins -o <data>/bins`
  (`packages/manager/src/prepare.ts`, `prepare_bins` in config.toml, on by default). It runs beside everything else,
  so the manager answers meanwhile; extractors of a kind with a screen wait for it, then get `DITHER_BINS=<data>/bins`
  (docs/supervisor.md). A failed build keeps the last good out-link (those kinds run on it) and is tried again in
  the background, 30 s later, then twice as long each time, up to 30 min, until one succeeds (`KeptBins`). With no
  earlier out-link those kinds wait until then, and the manager's page shows a banner while it fails. A machine
  with no `nix-build` skips it.
- **The forks' servers** are built the same way into `<data>/bins-forks` (`-A dither-bins-forks`), with their own
  state on the page (`forkBins`), after the first build is ready and only once a backend that needs them is in use:
  an account starting on `kasmvnc` or `wayland-tigervnc`, or one of those picked on the page. Picking one before they
  are built starts the build and is refused meanwhile (it is offered as "built when picked", then "building…"); while
  they cannot be built it is offered disabled, saying why, and x11 and the rest carry on. An account on one waits for
  them and gets both directories, `DITHER_BINS=<data>/bins:<data>/bins-forks`.
- **An extractor** resolves a program with `resolveBin` (`packages/browser/src/bins.ts`): its `*_BIN` override
  (`SWAY_BIN`, `WAYVNC_BIN`, `CHROMIUM_BIN`, …), then `<dir>/<attr>/bin/<name>` in each of `$DITHER_BINS`'s
  directories (`:` between, as PATH), then PATH. A program with
  `pinned: true` found nowhere fails at once with what to run. Nothing is ever built there: `resolveBin` is
  synchronous, and a build would block the extractor's event loop for minutes.
- **CI's `nix` job** points `NIX_PATH` and the `nixpkgs` registry entry at the same revision, installs the few
  programs the tests want on PATH from it (`nix-env -f ./nix -iA …`), then
  `bun scripts/prepare-bins.ts --out /tmp/dither-bins --tests`, which builds both (the forks' into
  `/tmp/dither-bins-forks`) and prints `DITHER_BINS=/tmp/dither-bins:/tmp/dither-bins-forks`.
- **Running the tests that need it yourself:**

  ```
  bun scripts/prepare-bins.ts --out <dir> --tests        # prints DITHER_BINS=<dir>:<dir>-forks
  DITHER_BINS=<dir>:<dir>-forks bun test packages/browser packages/sandbox
  ```

  `--no-forks` leaves the forks' servers out (their backends' tests then skip). Delete `<dir>` and `<dir>-forks` when
  done; they are GC roots until then. The tests that run a real browser on X (`test/*-browser.test.ts`,
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
- **A program nixpkgs lacks or that is built here**: `nix/<name>.nix`, an attribute in `overlay.nix`
  (`<name> = final.callPackage ./<name>.nix { };`), then the same two steps. It is built in the same `nix-build`, with
  the same GC root. A patched build of an upstream program goes in a fork instead (below).
- **A display backend:** its entry in `packages/spec/src/display.ts` (`BACKENDS`: name, protocol, label), its
  `Screen` class in `packages/browser/src/screen.ts`'s `SCREENS`, and its programs as above (docs/browser.md, "Display
  backends").

## Forks

Two VNC servers need patches upstream has not released, so they are built from forks this project keeps, each a
`dither` branch of commits on upstream's latest stable tag. Both are experimental backends (docs/browser.md, "Display
backends").

| attribute | fork | backend | what the fork carries |
|---|---|---|---|
| `w0vncserver` | [zyansheep/tigervnc](https://github.com/zyansheep/tigervnc) | `wayland-tigervnc` | backports of upstream's unreleased Wayland work (the clipboard on wlroots, a missing portal), and fixes for a headless seat with no keyboard |
| `kasmvnc` | [zyansheep/KasmVNC](https://github.com/zyansheep/KasmVNC) | `kasmvnc` | standard RFB for a client that is not KasmVNC's own (noVNC, our input client), a build from source with CMake 4, FFmpeg found by soname |

Each fork's own CI follows upstream's stable tags: it rebases the commits onto a new one, builds, runs a smoke test
and releases `<upstream tag>-dither.<n>`, with a self-contained nix file (`fetchFromGitHub` at that tag, with its
hash). `nix/<name>.nix` is that file, copied as it is: it says which tag it builds and which nixpkgs the fork's CI
tested it against; here it is built against `pin.json` like everything else.

**Bumping.** `.github/workflows/fork-bump.yml` runs `scripts/fork-bump.sh` for each fork every day and by hand
(Actions → Fork bump → Run workflow). When a fork has a newer release, it copies the release's file onto the branch
`fork-bump/<name>`, opens one pull request for that fork (or updates the open one), and starts CI on it. CI's `nix`
job builds the new file and runs that backend's tests with `DITHER_TESTS_NEED_ALL`. It never merges: merge it by
hand once it is green. By hand: `DRY_RUN=1 NAME=kasmvnc FORK=zyansheep/KasmVNC BACKEND=kasmvnc scripts/fork-bump.sh`
writes the newer file into the working tree and stops.

**Changing a patch.** Commit it on the fork's `dither` branch; its CI makes the next release, and the bump brings it
here. Nothing is patched in this repo.
