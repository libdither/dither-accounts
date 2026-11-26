# This repo's additions to the pinned nixpkgs (default.nix). A program nixpkgs lacks, or one built differently (a
# patched VNC server, say), goes here as an attribute (`name = final.callPackage ./name.nix { };`), then into
# bins.json and a BinSpec with `pinned: true` (nix/README.md).
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
  dither-bins = farm "dither-bins" bins.run;
  dither-test-bins = farm "dither-test-bins" (bins.run ++ bins.test);
}
