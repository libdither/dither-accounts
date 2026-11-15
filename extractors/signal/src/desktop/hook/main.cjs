/**
 * Signal Desktop's main process, before the app loads (`electron -r main.cjs app.asar`): adds preload.cjs to every
 * session, so it runs in the app's own preload world (beside Signal's preload, with its window.reduxActions and its
 * @signalapp/ringrtc), in every window. Beyond that it lets audio play without a click (the device's microphone, into
 * the sandbox's own sink), keeps its windows from being throttled as if hidden, and looks after the main window: a
 * renderer that crashed is loaded again, and one that hangs has where it hangs written down first (code locations
 * only: function names, files and lines, never a value) to ~/dither-hang.json, which the extractor logs.
 * docs/signal.md "Calls through Signal Desktop".
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const PRELOAD = path.join(__dirname, 'preload.cjs');

function add(session) {
  if (typeof session.registerPreloadScript === 'function') session.registerPreloadScript({ type: 'frame', id: 'dither-calls', filePath: PRELOAD });
  else session.setPreloads([...session.getPreloads(), PRELOAD]);
}
app.on('session-created', add);
// The device's microphone plays into the sandbox's own sink with no click to allow it.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** Where a hung page's main thread is: pause it through the debugger, keep the stack's locations, let it go. */
async function whereHung(wc) {
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    const paused = new Promise((resolve) => dbg.once('message', (_e, method, params) => method === 'Debugger.paused' && resolve(params)));
    await dbg.sendCommand('Debugger.enable');
    await dbg.sendCommand('Debugger.pause');
    const p = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 3000))]);
    const frames = p ? p.callFrames.slice(0, 40).map((f) => ({ fn: f.functionName || '(anonymous)', file: path.basename(f.url || ''), line: f.location.lineNumber + 1, col: f.location.columnNumber + 1 })) : null;
    fs.writeFileSync(path.join(process.env.HOME, 'dither-hang.json'), JSON.stringify({ at: Date.now(), reason: p ? p.reason : 'did not pause', frames }));
    await dbg.sendCommand('Debugger.resume').catch(() => {});
    dbg.detach();
  } catch (e) {
    try {
      fs.writeFileSync(path.join(process.env.HOME, 'dither-hang.json'), JSON.stringify({ at: Date.now(), error: String(e) }));
    } catch {}
  }
}

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  // Nothing on this display is ever in front or focused (there is no window manager): keep the window's timers,
  // frames and media running as if it were.
  wc.setBackgroundThrottling(false);
  let probed = false;
  win.on('unresponsive', () => {
    if (probed) return;
    probed = true;
    void whereHung(wc);
  });
  win.on('responsive', () => {
    probed = false;
  });
  wc.on('render-process-gone', (_ev, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    // A crashed main window would stay blank, with no calls: load it again.
    setTimeout(() => {
      if (!win.isDestroyed()) wc.reload();
    }, 1000);
  });
});
