# This repo's additions to the pinned nixpkgs (default.nix). A program nixpkgs lacks, or one built differently (a
# patched VNC server, say), goes here as an attribute, then into bins.json and a BinSpec with `pinned: true`
# (nix/README.md).
final: prev:
let
  bins = builtins.fromJSON (builtins.readFile ./bins.json);
  # One link per package, named by its attribute ("xorg.xev" too), to the package's own store path: a single out-link
  # of this is a GC root for every one of them.
  farm = name: attrs:
    final.linkFarm name (map (a: {
      name = a;
      path = final.lib.getAttrFromPath (final.lib.splitString "." a) final;
    }) attrs);
in
{
  # The two VNC servers built from forks this project keeps, which carry our patches on upstream's stable releases
  # (docs/browser.md "Display backends"). Each file is the fork's release asset as it is (it names its tag and the
  # source's hash); .github/workflows/fork-bump.yml replaces it when the fork makes a new release.
  #   w0vncserver  TigerVNC's Wayland server, from github.com/zyansheep/tigervnc (the wayland-tigervnc backend)
  #   kasmvnc      KasmVNC's Xvnc (Xkasmvnc), from github.com/zyansheep/KasmVNC (the kasmvnc backend)
  w0vncserver = import ./w0vncserver.nix { pkgs = final; };
  kasmvnc = import ./kasmvnc.nix { pkgs = final; };

  # Built apart (packages/manager prepare.ts): the forks' servers take minutes to build from source where no cache has
  # them, and one that fails to build must not hold up, or take down, the backends nixpkgs ships.
  dither-bins = farm "dither-bins" bins.run;
  dither-bins-forks = farm "dither-bins-forks" bins.forks;
  dither-test-bins = farm "dither-test-bins" (bins.run ++ bins.test);
}
