# The Google Messages bridge (libgm from mautrix-gmessages; AGPL-3.0-or-later, see LICENSE). Built by the extractor
# on first start when it is not on PATH:
#   nix build --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}.callPackage ./package.nix {}'
{ lib, buildGoModule }:

buildGoModule {
  pname = "dither-gm-bridge";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./go.mod ./go.sum ./main.go ./mapping.go ./cookies.go ./mapping_test.go ./cookies_test.go ];
  };
  vendorHash = "sha256-3alOzdGitcVDv+itCIC4ETWbEuZC3sJuwAecgrr9O/c=";
  # Pure Go: no cgo, so the binary needs nothing from the system.
  env.CGO_ENABLED = "0";
  ldflags = [ "-s" "-w" ];
  postInstall = "mv $out/bin/gm-bridge $out/bin/dither-gm-bridge";
  meta = {
    description = "Google Messages for dither-accounts (libgm, line protocol)";
    license = lib.licenses.agpl3Plus;
    mainProgram = "dither-gm-bridge";
  };
}
