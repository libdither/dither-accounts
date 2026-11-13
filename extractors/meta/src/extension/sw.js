/*
 * MV3 service worker. Owns the one WebSocket to the local extractor (token from the packaged config.json, which the
 * page cannot read) and passes messages between it and the app page's content-script ports. It also tells the
 * extractor which page each tab is on (origin and path only, never the query or hash), so it knows when the browser
 * is on a sign-in or checkpoint page.
 *
 * Commands go to one page only (the newest port), never to every tab: a write must happen once. The one command it
 * runs itself is `mediaFetch`: an attachment's bytes from Meta's CDN, fetched as the page's own <img> or <video> would
 * fetch them (no cookies; these links are signed), and only from Meta's media hosts.
 */
'use strict';

let CONFIG = null;
let ws = null;
let wsReady = false;
const ports = []; // app pages' ports, oldest first
const outbox = []; // frames queued while the socket is down
let backoff = 500;
let lastTabs = '';
let tabsTimer = null;
const MEDIA_HOSTS = [/(^|\.)fbcdn\.net$/, /(^|\.)cdninstagram\.com$/, /(^|\.)fbsbx\.com$/];
const MEDIA_MAX = 60 * 1024 * 1024;

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
    if (outbox.length > 2000) outbox.splice(0, outbox.length - 2000);
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

async function reportTabs(force) {
  try {
    const tabs = await chrome.tabs.query({});
    const hooked = new Set(ports.map((p) => p.sender && p.sender.tab && p.sender.tab.id));
    const list = tabs.map((t) => ({ id: t.id, url: bare(t.url || t.pendingUrl || ''), active: !!t.active, hook: hooked.has(t.id) }));
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

function mediaAllowed(url, cfg) {
  try {
    const u = new URL(url);
    if (cfg && cfg.testOrigin && u.origin === cfg.testOrigin) return true;
    return u.protocol === 'https:' && MEDIA_HOSTS.some((re) => re.test(u.hostname));
  } catch (e) {
    return false;
  }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function mediaFetch(id, url) {
  const cfg = await loadConfig();
  if (!mediaAllowed(url, cfg)) return sendUp({ t: 'reply', id, ok: false, error: 'not a Meta media host' });
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', redirect: 'follow' });
    if (!res.ok) return sendUp({ t: 'reply', id, ok: false, error: `media host answered ${res.status}` });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MEDIA_MAX) return sendUp({ t: 'reply', id, ok: false, error: 'too large' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MEDIA_MAX) return sendUp({ t: 'reply', id, ok: false, error: 'too large' });
    sendUp({ t: 'reply', id, ok: true, result: { mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0], base64: toBase64(bytes) } });
  } catch (e) {
    sendUp({ t: 'reply', id, ok: false, error: 'media fetch failed' });
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
    if (msg.t !== 'cmd') return; // pings only keep this worker awake
    if (msg.cmd && msg.cmd.kind === 'mediaFetch') return void mediaFetch(msg.id, String(msg.cmd.url || ''));
    const port = ports[ports.length - 1];
    if (!port) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: 'the app is not open in the sandbox' });
      return;
    }
    try {
      port.postMessage(msg);
    } catch (err) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: 'the app page went away' });
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

chrome.runtime.onConnect.addListener(async (port) => {
  ports.push(port);
  port.onMessage.addListener((payload) => sendUp(payload));
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i >= 0) ports.splice(i, 1);
    tabsChanged();
  });
  connect();
  tabsChanged();
  const cfg = await loadConfig();
  // What the hook needs (not the token): the site it serves and what was learned of the client's own requests.
  try {
    port.postMessage({ t: 'settings', settings: { site: (cfg && cfg.site) || null, testOrigin: (cfg && cfg.testOrigin) || null, learned: (cfg && cfg.learned) || null } });
  } catch (e) {}
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
