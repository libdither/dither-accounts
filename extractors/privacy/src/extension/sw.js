/*
 * MV3 service worker. Owns the one WebSocket to the local extractor (token from the packaged config.json, which the
 * page cannot read) and passes messages between it and the privacy.com pages' content-script ports.
 *
 * Passkey requests ({ t: 'webauthn' } from the page hook) go up with the caller's origin as CHROMIUM reports it for
 * the port (port.sender.origin), never as the page says it: that origin is what the extractor checks the rpId against
 * and writes into clientDataJSON. The extractor's answer comes back down as a command, `webauthn.answer`, which this
 * worker handles itself: it goes to that tab's page, nowhere else. That half is packages/browser/src/page/
 * webauthn-worker.js (`passkeys`), put in below when the extension is copied (docs/passkeys.md).
 *
 * It also tells the extractor which page each tab is on (origin and path only, never the query or hash): that is how
 * the account knows whether Privacy is signed in. `tab.go` loads a page in the account's tab (the one you see in the
 * live view), as typing it in the address bar would; any other command goes to the newest privacy.com page (hook.js).
 */
'use strict';

let CONFIG = null;
let ws = null;
let wsReady = false;
const outbox = []; // frames queued while the socket is down
let backoff = 500;
let lastTabs = '';
let tabsTimer = null;

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

function sendUp(payload) {
  const frame = JSON.stringify(payload);
  if (wsReady && ws && ws.readyState === 1) ws.send(frame);
  else {
    outbox.push(frame);
    if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
    connect();
  }
}

/** Origin and path, no query or hash; other schemes by scheme and host only. */
function bare(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : `${u.protocol}//${u.host}`;
  } catch (e) {
    return '';
  }
}

/*@include webauthn-worker@*/
const ports = passkeys.ports; // privacy.com pages' ports, oldest first

async function reportTabs(force) {
  try {
    const tabs = await chrome.tabs.query({});
    const hooked = new Set(ports.map((p) => p.sender && p.sender.tab && p.sender.tab.id));
    const list = tabs.map((t) => ({ id: t.id, url: bare(t.url || t.pendingUrl || ''), active: !!t.active, loading: t.status === 'loading', hook: hooked.has(t.id) }));
    const s = JSON.stringify(list);
    if (s === lastTabs && !force) return;
    lastTabs = s;
    sendUp({ t: 'tabs', tabs: list });
  } catch (e) {}
}
function tabsChanged() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => reportTabs(false), 150);
}

function answer(msg) {
  try {
    sendUp({ t: 'reply', id: msg.id, ok: true, result: passkeys.answer(msg.cmd) });
  } catch (e) {
    sendUp({ t: 'reply', id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}

/** Load a page in the account's tab (the active one, else the first; a new one when there is none). */
async function tabGo(msg) {
  try {
    const url = String((msg.cmd && msg.cmd.url) || '');
    if (!/^https?:\/\//.test(url)) throw new Error('only http(s) pages');
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.active) || tabs[0];
    const done = t ? await chrome.tabs.update(t.id, { url, active: true }) : await chrome.tabs.create({ url, active: true });
    sendUp({ t: 'reply', id: msg.id, ok: true, result: { tabId: done && done.id } });
  } catch (e) {
    sendUp({ t: 'reply', id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const cfg = await loadConfig();
  if (!cfg || !cfg.wsUrl) {
    setTimeout(connect, 2000);
    return;
  }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
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
    ws.send(JSON.stringify({ t: 'ready' }));
    while (outbox.length && ws.readyState === 1) ws.send(outbox.shift());
    reportTabs(true);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (msg.t !== 'cmd' || !msg.cmd) return; // pings only keep this worker awake
    if (msg.cmd.kind === 'webauthn.answer') return answer(msg);
    if (msg.cmd.kind === 'tab.go') return tabGo(msg);
    // Anything else is for the page (the newest one): one page only, never every tab.
    const port = ports[ports.length - 1];
    if (!port) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: 'Privacy is not open in the sandbox' });
      return;
    }
    try {
      port.postMessage(msg);
    } catch (err) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: 'the Privacy page went away' });
    }
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

chrome.runtime.onConnect.addListener((port) => {
  passkeys.connect(port, (payload) => sendUp(payload));
  port.onDisconnect.addListener(() => tabsChanged());
  connect();
  tabsChanged();
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status) tabsChanged();
});
chrome.tabs.onActivated.addListener(tabsChanged);
chrome.tabs.onRemoved.addListener(tabsChanged);
chrome.tabs.onCreated.addListener(tabsChanged);

// Keepalive: the alarm wakeup itself extends the worker's life; the extractor's pings do too.
try {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    if (!ws || ws.readyState > 1) connect();
  });
} catch (e) {}

self.addEventListener('activate', () => connect());
connect();
