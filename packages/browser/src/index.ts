/**
 * Browser-session extractors' shared parts: the sandbox (Xvfb + Chromium + extension + x11vnc), its bridge, a free
 * display, the live view's socket, and the names its extensions leave in pages, made per install.
 */
export { BridgeServer, type BridgeReply, type BridgeServerOpts } from './bridge.ts';
export { displayTaken, type FreeDisplay, pickFreeDisplay, portInUse } from './display.ts';
export { MARKER_KEY_ENV, markerHex, markerKey, markerName, stampExtension, stampMarkers } from './markers.ts';
export { type Bins, type Log, resolveBins, Sandbox, type SandboxOptions } from './sandbox.ts';
export { prepareVncSocket, SOCKET_PATH_MAX, VNC_SOCKET, vncSocketPath, waitForVncSocket, x11vncArgs } from './vnc.ts';
export { importedScripts, profileHolder, refreshWorker, WORKER_HASH, WORKER_STORAGE, workerHash, type WorkerRefresh } from './worker.ts';
