/**
 * Browser-session extractors' shared parts: the sandbox (a screen + Chromium + extension + live view), the screen
 * itself and its backends (x11: Xvfb + x11vnc; tigervnc, kasmvnc: an Xvnc; wayland, wayland-tigervnc: sway + wayvnc or w0vncserver; the list is packages/spec display.ts), its bridge, a free display, the live view's
 * socket, and the names its extensions leave in pages, made per install.
 */
export { BinNotPrepared, BINS_ENV, type BinSpec, cleanEnv, DISPLAY_BINS, preparedBin, resolveBin, tryBin } from './bins.ts';
export { BridgeServer, type BridgeReply, type BridgeResend, type BridgeServerOpts, type BridgeSilence, RESEND_MAX, RESEND_MS, type Reached } from './bridge.ts';
export { DIAGNOSE_MS, diagnoseSilence, pathTemplate, type SilenceOpts } from './silence.ts';
export { MEMORY_DISABLED_FEATURES, mergeFeatureFlags } from './flags.ts';
export { BACKENDS, claimDisplay, DISPLAY_BACKEND_ENV, DISPLAY_BACKENDS, type DisplayBackend, displayBackend, displayIsOurs, displayTaken, type FreeDisplay, isWaylandBackend, isXBackend, parseBackend, pickFreeDisplay, pickFreeXDisplay, portInUse, type WaylandBackend, type WaylandDisplay, type XBackend, type XDisplay } from './display.ts';
export { MARKER_KEY_ENV, markerHex, markerKey, markerName, stampExtension, stampMarkers } from './markers.ts';
export { type Bins, gpuFlags, type Log, resolveBins, resolveChromium, Sandbox, type SandboxOptions } from './sandbox.ts';
export { displayName, displayNote, displayState, makeScreen, type Screen, type ScreenHealth, type ScreenInput, type ScreenOptions, type ScreenSpawn } from './screen.ts';
export { KeptServer, prepareVncSocket, SOCKET_PATH_MAX, VNC_SOCKET, vncSocketPath, waitForVncSocket, waitForRfbBanner, x11vncArgs, xvncArgs, XVNC_EXTRA, type XvncBackend } from './vnc.ts';
export { privateDir, renderNode, swayConfig, waylandDir, waylandPlace, WaylandScreen, w0vncserverArgs, w0vncserverEnv, WAYLAND_SERVERS, wayvncArgs } from './wayland.ts';
export { browserShare, busConf, portalsConf, SHARE_BINS, SHARE_DIR, SHARE_OUTPUT, ScreenShare, type ScreenShareOptions, wireplumberConf, wlrConfig } from './screenshare.ts';
export { importedScripts, profileHolder, refreshWorker, WORKER_HASH, WORKER_STORAGE, workerHash, type WorkerRefresh } from './worker.ts';
export { addSignInPage, SIGN_IN_PAGE, SignInAnswerer, SignInAsker, signInConfig } from './signin.ts';
