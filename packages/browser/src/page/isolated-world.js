/*
 * content.js, the ISOLATED-world content script of every hook: it passes messages between the MAIN-world hook and the
 * service worker (a long-lived chrome.runtime port), and holds no secrets and makes no network calls. Each extension's
 * content.js is a few lines that set QUEUE and put this file in place of their `include isolated-world` marker when
 * the extension is copied (packages/browser/src/markers.ts).
 *
 *   hook.js --event(up)--> content.js --port--> sw.js --ws--> extractor
 *   extractor --ws--> sw.js --port--> content.js --event(down)--> hook.js
 *
 * The hook's end is main-world.js: CustomEvents of this install's own types on window, never window messages. Each
 * end says hello (a null detail) when it starts, and the other answers, so it does not matter which world Chromium
 * runs first. QUEUE: how many frames the hook said to keep while the port is down (0: drop them).
 */
const UP = '__MARK_up__';
const DOWN = '__MARK_down__';
let port = null;
const queue = [];

const toHook = (detail) => window.dispatchEvent(new CustomEvent(DOWN, { detail }));

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'bridge' });
  } catch (e) {
    // service worker not ready yet; retry shortly
    port = null;
    setTimeout(connect, 1000);
    return;
  }
  port.onMessage.addListener((payload) => toHook(payload));
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1000);
  });
  while (queue.length && port) port.postMessage(queue.shift());
}

window.addEventListener(UP, (e) => {
  const payload = e.detail;
  // The hook's hello (or a frame that would not clone): answer, so a hook that started first starts talking.
  if (payload === null || payload === undefined) return toHook(null);
  try {
    if (port) port.postMessage(payload);
    else if (queue.length < QUEUE) queue.push(payload);
  } catch (err) {
    // the port died between checks: keep the frame for the next one
    if (queue.length < QUEUE) queue.push(payload);
    connect();
  }
});

// Chrome caps a port's lifetime; open a new one well before the 5-minute limit so the pipe never goes stale.
setInterval(() => {
  try {
    port && port.disconnect();
  } catch (e) {}
  connect();
}, 250000);

connect();
toHook(null); // hello: a hook that is already running starts talking
