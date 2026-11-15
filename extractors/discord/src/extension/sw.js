/*
 * MV3 service worker. Owns the one WebSocket to the local chat adapter and
 * fans messages between it and the content-script ports. The adapter token lives
 * only here (loaded from the packaged config.json), never in the page.
 *
 * Staying alive: an open runtime port and active WebSocket traffic already reset
 * the idle timer on modern Chromium; a short alarm is a belt-and-braces wakeup.
 */
'use strict';

let CONFIG = null;
let ws = null;
let wsReady = false;
const ports = new Set();
const outbox = []; // frames queued while the socket is down
let backoff = 500;

async function loadConfig() {
  if (CONFIG) return CONFIG;
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    CONFIG = await res.json();
  } catch (e) {
    CONFIG = null;
  }
  return CONFIG;
}

function sendToAdapter(payload) {
  const frame = JSON.stringify(payload);
  if (wsReady && ws && ws.readyState === 1) ws.send(frame);
  else {
    outbox.push(frame);
    if (outbox.length > 5000) outbox.splice(0, outbox.length - 5000);
    connect();
  }
}

function toPorts(payload) {
  for (const p of ports) {
    try {
      p.postMessage(payload);
    } catch (e) {
      ports.delete(p);
    }
  }
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const cfg = await loadConfig();
  if (!cfg || !cfg.wsUrl) {
    setTimeout(connect, 2000);
    return;
  }
  const url = cfg.wsUrl + (cfg.wsUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token || '');
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
    return;
  }
  ws.onopen = () => {
    wsReady = true;
    backoff = 500;
    sendToAdapter({ t: 'ready' });
    while (outbox.length && ws.readyState === 1) ws.send(outbox.shift());
  };
  ws.onmessage = (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (cmd.t === 'ping') return; // keepalive from the adapter
    if (cmd.t === 'cmd' && cmd.cmd && cmd.cmd.kind === 'tab.reload') {
      reloadTab(cmd.id, cmd.cmd);
      return;
    }
    // No page to run it in: say so now, rather than drop it and leave the adapter to time out.
    if (cmd.t === 'cmd' && ports.size === 0) {
      sendToAdapter({ t: 'reply', id: cmd.id, ok: false, error: NO_PAGE, from: 'worker' });
      return;
    }
    toPorts(cmd); // { t:'cmd', id, cmd } -> content.js -> hook.js
  };
  ws.onclose = () => {
    wsReady = false;
    ws = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => {
    try {
      ws && ws.close();
    } catch (e) {}
  };
}

const NO_PAGE = 'the Discord page is not open in the sandbox';
const HOME = 'https://discord.com/app';

/**
 * tab.reload: the Discord tab sent back to `url` (a navigation, which also gets a tab stuck loading or on an error page
 * going again), or a new tab on it when there is none. The adapter asks when the page never spoke or stopped answering.
 */
async function reloadTab(id, cmd) {
  try {
    const url = typeof cmd.url === 'string' && /^https:\/\/discord\.com\//.test(cmd.url) ? cmd.url : HOME;
    const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
    let how = 'opened';
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { url });
      how = 'navigated';
    } else await chrome.tabs.create({ url, active: true });
    sendToAdapter({ t: 'reply', id, ok: true, result: { how }, from: 'worker' });
  } catch (e) {
    sendToAdapter({ t: 'reply', id, ok: false, error: String((e && e.message) || e), from: 'worker' });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  connect();
  port.onMessage.addListener((payload) => {
    // anything the hook emits (snapshot, dispatch, finders, replies, logs)
    sendToAdapter(payload);
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

// Keepalive: the alarm wakeup itself extends the worker's life.
try {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    if (!ws || ws.readyState > 1) connect();
  });
} catch (e) {}

self.addEventListener('activate', () => connect());
connect();
