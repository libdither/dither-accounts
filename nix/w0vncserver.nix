# TigerVNC's Wayland server (w0vncserver), for the `wayland-tigervnc` display backend (docs/browser.md "Display
# backends"): nixpkgs' tigervnc with two fixes of ours, and without its Xvnc (the tigervnc backend runs nixpkgs' own).
# Both are about a headless compositor, which w0vncserver 1.16.2 does not expect:
#   w0vncserver-no-portal.patch       with no desktop portal to ask (no session bus, or none on it) it exited at
#                                     start; now it uses the compositor's own protocols (wlr-screencopy,
#                                     wlr-virtual-pointer, virtual-keyboard), as it does when the portal lacks
#                                     RemoteDesktop. So it needs no session bus at all, and is given none.
#   w0vncserver-headless-seat.patch   a headless sway has no input devices, so its seat has no keyboard, and it read
#                                     that missing keyboard's keymap when the first client connected (SIGSEGV in
#                                     VirtualKeyboard's constructor). Now the virtual keyboard gets libxkbcommon's
#                                     default keymap, sway adds it to the seat, and w0vncserver takes the seat's keymap
#                                     from there as it does on a desktop.
# Build: nix build -f nix/w0vncserver.nix
{ pkgs ? import <nixpkgs> { } }:
pkgs.tigervnc.overrideAttrs (old: {
  pname = "w0vncserver";
  patches = (old.patches or [ ]) ++ [ ./w0vncserver-no-portal.patch ./w0vncserver-headless-seat.patch ];
  # Only the Wayland server: no viewer, and not the Xvnc nixpkgs builds and installs here from the X server's sources.
  cmakeFlags = (old.cmakeFlags or [ ]) ++ [ (pkgs.lib.cmakeBool "BUILD_VIEWER" false) ];
  postBuild = "";
  postInstall = "";
  meta = old.meta // { mainProgram = "w0vncserver"; };
})
