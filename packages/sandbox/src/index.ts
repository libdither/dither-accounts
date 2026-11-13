/** A native app in a sandbox the extractor owns: display and live view, a private bus with our desktop services, shims, downloads (docs/native-sandbox.md). */
export { type BinSpec, BINS, resolveBin, type SandboxBins, sandboxBins, tryBin } from './bins.ts';
export { DBusConnection, DBusError, decodeMessage, encodeMessage, marshal, type Message, MsgType, splitSignature, unmarshal, type Variant, variant } from './dbus.ts';
export { AppSandbox, type AppSandboxOptions, type Download, type FileRequestRecord, listFiles, mergeMimeapps, mimeOf, type Network, runtimeDir, safeName, type SandboxEvent } from './sandbox.ts';
export { CAPABILITIES, DesktopServices, type FileRequest, fileUri, type Notification, SANDBOX_NAME, SANDBOX_PATH, SERVER_INFO } from './services.ts';
export { pickFreeDisplay, portInUse } from '@dither-accounts/browser';
