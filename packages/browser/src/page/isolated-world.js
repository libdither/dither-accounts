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
 *
 * Chromium caps a port's life, so the port is replaced every ROTATE_MS, new one first. The old one stays open for
 * DRAIN_MS more: the worker sends a command to the port it knows as the page's newest, and one it handed to the old
 * port just before it heard of the new one must still arrive. Closing the old port at once lost it (a Gmail page's
 * `gmail.sync`, now and then, "did not answer in 25 s"). A worker that sends to every port (Discord's) may hand the
 * same command to both meanwhile: a command id already passed to the hook is not passed again.
 */
const UP = '__MARK_up__';
const DOWN = '__MARK_down__';
const ROTATE_MS = 250000;
const DRAIN_MS = 10000;
let port = null;
const queue = [];
const seen = new Set(); // ids of the commands passed down lately
const SEEN = 500;

const toHook = (detail) => window.dispatchEvent(new CustomEvent(DOWN, { detail }));

function down(payload) {
  if (payload && payload.t === 'cmd' && payload.id != null) {
    if (seen.has(payload.id)) return;
    seen.add(payload.id);
    if (seen.size > SEEN) seen.delete(seen.values().next().value);
  }
  toHook(payload);
}

/** A new port, made the current one; false when the worker could not be reached (the current one stays). */
function connect() {
  let p;
  try {
    p = chrome.runtime.connect({ name: 'bridge' });
  } catch (e) {
    // service worker not ready yet; retry shortly
    if (!port) setTimeout(connect, 1000);
    return false;
  }
  p.onMessage.addListener(down);
  p.onDisconnect.addListener(() => {
    // An old port, closed while it drained, is not the channel going down.
    if (port !== p) return;
    port = null;
    setTimeout(connect, 1000);
  });
  port = p;
  while (queue.length && port) port.postMessage(queue.shift());
  return true;
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

// Chrome caps a port's lifetime; open a new one well before the 5-minute limit so the pipe never goes stale, and
// close the old one once what was already on its way to it has arrived.
setInterval(() => {
  const old = port;
  if (!connect() || !old) return;
  setTimeout(() => {
    try {
      old.disconnect();
    } catch (e) {}
  }, DRAIN_MS);
}, ROTATE_MS);

connect();
toHook(null); // hello: a hook that is already running starts talking
