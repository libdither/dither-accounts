# The WhatsApp bridge binary (whatsmeow). Built by the adapter on first start when it is not on PATH:
#   nix build --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}.callPackage ./package.nix {}'
# and exposed by the repo flake as .#wa-bridge.
{ lib, buildGoModule }:

buildGoModule {
  pname = "dither-wa-bridge";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./go.mod ./go.sum ./main.go ./fixtures.go ];
  };
  vendorHash = "sha256-RIww1oHpRfTYDjOAUzeN0tRuA7jEffAJccbpLyCBm5M=";
  # mattn/go-sqlite3 needs cgo; buildGoModule's stdenv has a C compiler.
  env.CGO_ENABLED = "1";
  tags = [ "sqlite_fts5" ];
  ldflags = [ "-s" "-w" ];
  postInstall = "mv $out/bin/wa-bridge $out/bin/dither-wa-bridge";
  meta.mainProgram = "dither-wa-bridge";
}
