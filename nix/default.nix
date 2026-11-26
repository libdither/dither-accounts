# The pinned nixpkgs (pin.json) with this repo's overlay (overlay.nix): where the sandboxes' programs come from, in
# CI and at run time (nix/README.md).
#
#   nix-build nix -A dither-bins -o <dir>        the programs the sandboxes run, one link per package (bins.json "run")
#   nix-build nix -A dither-test-bins -o <dir>   those and what only the tests run (bins.json "test")
#   nix-env -f nix -iA chromium                  any package of the same nixpkgs
{ }:
let
  pin = builtins.fromJSON (builtins.readFile ./pin.json);
  nixpkgs = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${pin.rev}.tar.gz";
    inherit (pin) sha256;
  };
in
import nixpkgs {
  config = { };
  overlays = [ (import ./overlay.nix) ];
}
