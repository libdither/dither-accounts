# One pinned nixpkgs for the sandboxes' programs

Every program a screen or a sandbox starts (Xvfb, x11vnc, xdotool, ImageMagick; the Xvnc servers; sway, wayvnc, grim;
dbus, PipeWire, WirePlumber, the portals; bubblewrap, pasta, xwayland-satellite) comes from one nixpkgs revision, the
same in CI and at run time, built ahead of time. An extractor never runs `nix build`: it would block its event loop,
and it would get whatever nixpkgs the machine's registry says that day.

| file | |
|---|---|
| `pin.json` | the nixpkgs revision and its tarball's hash |
| `bins.json` | the attributes built: `run`, what the sandboxes start; `test`, what only the tests start (Electron, xev, wev) |
| `overlay.nix` | this repo's additions: `dither-bins` and `dither-test-bins` (below), and any program nixpkgs lacks or that is built differently here |
| `w0vncserver.nix`, `kasmvnc.nix` | the two VNC servers built from forks (below), each its fork's release file as it is |
| `default.nix` | the pinned nixpkgs with the overlay |

## How a program is found

`dither-bins` is a directory with one link per attribute in `bins.json`'s `run` list (`sway-unwrapped`,
`xorg.xev`, …), each to that package's store path. One out-link to it is a GC root for all of them, so a garbage
collection never takes a program a sandbox is about to start.

- **The manager** builds it at its start: `nix-build <repo>/nix -A dither-bins -o <data>/bins`
  (`packages/manager/src/prepare.ts`, `prepare_bins` in config.toml, on by default). It runs beside everything else,
  so the manager answers meanwhile; extractors of a kind with a screen wait for it, then get `DITHER_BINS=<data>/bins`
  (docs/supervisor.md). A failed build keeps the last good out-link. A machine with no `nix-build` skips it.
- **An extractor** resolves a program with `resolveBin` (`packages/browser/src/bins.ts`): its `*_BIN` override
  (`SWAY_BIN`, `WAYVNC_BIN`, …), then `$DITHER_BINS/<attr>/bin/<name>`, then PATH. A program with `pinned: true` found
  nowhere fails at once with what to run, never a build.
- **CI's `nix` job** points `NIX_PATH` and the `nixpkgs` registry entry at the same revision, installs the few
  programs the tests want on PATH from it (`nix-env -f ./nix -iA …`), then
  `bun scripts/prepare-bins.ts --out /tmp/dither-bins --tests` and `DITHER_BINS=/tmp/dither-bins`.
- **Running the tests that need it yourself:**

  ```
  bun scripts/prepare-bins.ts --out <dir> --tests
  DITHER_BINS=<dir> bun test packages/browser packages/sandbox
  ```

  Delete `<dir>` when done; it is a GC root until then.

## Changing it

- **Moving the pin:** set `rev` in `pin.json` to a nixos-unstable commit, and `sha256` to
  `nix-prefetch-url --unpack https://github.com/NixOS/nixpkgs/archive/<rev>.tar.gz`. Run the tests that need Nix
  (above) before pushing; CI's `nix` job runs them on the new pin.
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
