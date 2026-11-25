# KasmVNC's X server (Xkasmvnc, a TigerVNC fork), for the `kasmvnc` display backend (docs/browser.md "Display
# backends"). nixpkgs has none, so this is upstream's Debian trixie build, its libraries patched to nixpkgs' ones.
# Build: nix build -f nix/kasmvnc.nix (or .#kasmvnc from the flake).
{ pkgs ? import <nixpkgs> { } }:
pkgs.stdenv.mkDerivation rec {
  pname = "kasmvnc";
  version = "1.5.2";
  src = pkgs.fetchurl {
    url = "https://github.com/kasmtech/KasmVNC/releases/download/v${version}/kasmvncserver_debian_trixie_${version}_amd64.deb";
    sha256 = "1y07jhja8ib7w9n5g7b9i4r4w0a5y615ylibwmf8l23m68b5gnbf";
  };
  nativeBuildInputs = [ pkgs.dpkg pkgs.autoPatchelfHook pkgs.makeWrapper pkgs.perl ];
  buildInputs = with pkgs; [
    libpng zlib libunwind pixman libxfont_2 libxau libxdmcp libxshmfence systemdLibs libGL libgbm openssl
    libxcrypt-legacy freetype libbsd stdenv.cc.cc.lib
  ];
  unpackPhase = "dpkg-deb -x $src .";
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share
    cp usr/bin/Xkasmvnc usr/bin/kasmvncpasswd $out/bin/
    cp -r usr/share/kasmvnc $out/share/
    # The X server runs "<XkbBinDirectory>/xkbcomp" to compile its keyboard map, with XkbBinDirectory built in as
    # /usr/bin and no flag to change it. It becomes "." (same length, NUL-padded) and the wrapper starts it in a
    # directory holding only an xkbcomp link, so it runs nixpkgs' one.
    perl -0777 -pi -e 's|/usr/bin\0|.\0\0\0\0\0\0\0\0|g or die "no /usr/bin in Xkasmvnc"' $out/bin/Xkasmvnc
    # Its video mode looks for FFmpeg's libavformat.so by walking /usr/lib/ and /usr/lib64 whole, at every start,
    # before it answers on its socket: on a Debian or Ubuntu machine that walk took 5-18 s (on NixOS, nothing to walk).
    # The sandboxes do not use that mode: both become ".", the wrapper's directory, which holds only the xkbcomp link.
    perl -0777 -pi -e 's|(?<=\0)/usr/lib/\0|.\0\0\0\0\0\0\0\0\0|g or die "no /usr/lib/ in Xkasmvnc"' $out/bin/Xkasmvnc
    perl -0777 -pi -e 's|(?<=\0)/usr/lib64\0|.\0\0\0\0\0\0\0\0\0\0|g or die "no /usr/lib64 in Xkasmvnc"' $out/bin/Xkasmvnc
    mkdir -p $out/libexec/kasmvnc
    ln -s ${pkgs.xkbcomp}/bin/xkbcomp $out/libexec/kasmvnc/xkbcomp
    # -xkbdir and -fp: the keyboard maps and fonts Debian's xkb-data and xfonts packages would bring. No FFmpeg (above:
    # it never looked on the library path anyway).
    wrapProgram $out/bin/Xkasmvnc --chdir $out/libexec/kasmvnc \
      --add-flags "-xkbdir ${pkgs.xkeyboard_config}/share/X11/xkb -fp ${pkgs.font-misc-misc}/share/fonts/X11/misc,built-ins"
    runHook postInstall
  '';
  meta = {
    description = "KasmVNC's X server with a VNC (and its own web client's) server built in";
    homepage = "https://github.com/kasmtech/KasmVNC";
    license = pkgs.lib.licenses.gpl2Plus;
    platforms = [ "x86_64-linux" ];
    mainProgram = "Xkasmvnc";
  };
}
