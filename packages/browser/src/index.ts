/**
 * Browser-session extractors' shared parts: the sandbox (a screen + Chromium + extension + live view), the screen
 * itself and its two backends (x11: Xvfb + x11vnc; wayland: sway + wayvnc), its bridge, a free display, the live view's
 * socket, and the names its extensions leave in pages, made per install.
 */
export { type BinSpec, cleanEnv, DISPLAY_BINS, resolveBin, tryBin } from './bins.ts';
export { BridgeServer, type BridgeReply, type BridgeResend, type BridgeServerOpts, type BridgeSilence, RESEND_MAX, RESEND_MS, type Reached } from './bridge.ts';
export { DIAGNOSE_MS, diagnoseSilence, pathTemplate, type SilenceOpts } from './silence.ts';
export { MEMORY_DISABLED_FEATURES, mergeFeatureFlags } from './flags.ts';
export { claimDisplay, DISPLAY_BACKEND_ENV, DISPLAY_BACKENDS, type DisplayBackend, displayBackend, displayIsOurs, displayTaken, type FreeDisplay, isWaylandBackend, isXBackend, parseBackend, pickFreeDisplay, pickFreeXDisplay, portInUse, WAYLAND_BACKENDS, type WaylandBackend, type WaylandDisplay, X_BACKENDS, type XBackend, type XDisplay } from './display.ts';
export { MARKER_KEY_ENV, markerHex, markerKey, markerName, stampExtension, stampMarkers } from './markers.ts';
export { type Bins, gpuFlags, type Log, resolveBins, resolveChromium, Sandbox, type SandboxOptions, screenFlags, screenPrefs } from './sandbox.ts';
export { displayName, displayNote, makeScreen, WAYLAND_NOTE, type Screen, type ScreenInput, type ScreenOptions, type ScreenSpawn } from './screen.ts';
export { prepareVncSocket, SOCKET_PATH_MAX, VNC_SOCKET, vncSocketPath, waitForVncSocket, x11vncArgs, xvncArgs } from './vnc.ts';
export { swayConfig, waylandDir, WaylandScreen, wayvncArgs } from './wayland.ts';
export { browserShare, busConf, portalsConf, SHARE_BINS, SHARE_DIR, SHARE_OUTPUT, ScreenShare, type ScreenShareOptions, wireplumberConf, wlrConfig } from './screenshare.ts';
export { importedScripts, profileHolder, refreshWorker, WORKER_HASH, WORKER_STORAGE, workerHash, type WorkerRefresh } from './worker.ts';
