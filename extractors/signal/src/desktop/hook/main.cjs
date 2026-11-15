/**
 * Signal Desktop's main process, before the app loads (`electron -r main.cjs app.asar`): adds preload.cjs to every
 * session, so it runs in the app's own preload world (beside Signal's preload, with its window.reduxActions and its
 * @signalapp/ringrtc), in every window. Beyond that it only lets audio play without a click (the device's microphone, into the sandbox's own sink). docs/signal.md "Calls through Signal Desktop".
 */
'use strict';
const { app } = require('electron');
const path = require('node:path');
const PRELOAD = path.join(__dirname, 'preload.cjs');

function add(session) {
  if (typeof session.registerPreloadScript === 'function') session.registerPreloadScript({ type: 'frame', id: 'dither-calls', filePath: PRELOAD });
  else session.setPreloads([...session.getPreloads(), PRELOAD]);
}
app.on('session-created', add);
// The device's microphone plays into the sandbox's own sink with no click to allow it.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
