/*
 * MV3 service worker. Owns the one WebSocket to the local extractor (token from the packaged config.json, which the
 * page cannot read) and passes messages between it and the pages' content-script ports. It also tells the extractor
 * which page each tab is on (origin and path only, never the query or hash), so it knows when the browser is on
 * Google's sign-in page, where nothing of ours runs.
 *
 * Two pages, each a role: 'calendar' (calendar.google.com) and 'gmail' (mail.google.com). A port's role is what its
 * hook announced (from its page's host), and until then what its sender's address says. A command for a page carries
 * its role (`page`, default 'calendar') and goes to that role's current port only (the newest: a reload or a
 * replacement takes over), never to every tab: a write must happen once. Commands of kind `tab.open` and `tab.reload`
 * are this worker's own: open a role's tab if it has none, or send it back to its start address (or close it and open
 * a new one), so the extractor can bring one page back without touching the other.
 *
 * Every frame a page sends up carries its port's role.
 */
'use strict';

const ROLES = ['calendar', 'gmail'];
const NAMES = { calendar: 'Google Calendar', gmail: 'Gmail' };

let CONFIG = null;
let ws = null;
let wsReady = false;
const ports = []; // the pages' ports, oldest first
const portRoles = new Map(); // port -> role
const tabRoles = new Map(); // tab id -> role: the tabs of its pages and the ones opened for a role
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
const configLoaded = loadConfig();

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

/** Which page an address is: Google's own hosts, or (tests) the origins in the config. */
function roleOfUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (u.protocol === 'https:' && u.host === 'mail.google.com') return 'gmail';
  if (u.protocol === 'https:' && u.host === 'calendar.google.com') return 'calendar';
  const mail = CONFIG && CONFIG.testMailOrigin;
  const cal = CONFIG && CONFIG.testOrigin;
  if (mail && u.origin === mail && (mail !== cal || u.pathname.startsWith('/mail/'))) return 'gmail';
  if (cal && u.origin === cal) return 'calendar';
  return null;
}

const tabOf = (port) => (port.sender && port.sender.tab && port.sender.tab.id) || null;
const roleOf = (port) => portRoles.get(port) || null;

function setRole(port, role) {
  if (!ROLES.includes(role)) return;
  portRoles.set(port, role);
  const tab = tabOf(port);
  if (tab === null) return;
  // Chromium must not discard a page we call into while it sits in the background.
  if (tabRoles.get(tab) !== role) chrome.tabs.update(tab, { autoDiscardable: false }).catch(() => {});
  tabRoles.set(tab, role);
}

/** The role's current page: its newest port. */
function current(role) {
  for (let i = ports.length - 1; i >= 0; i--) if (roleOf(ports[i]) === role) return ports[i];
  return null;
}

async function reportTabs(force) {
  try {
    const tabs = await chrome.tabs.query({});
    const hooked = new Map(); // tab id -> role of a port in it
    for (const p of ports) if (tabOf(p) !== null) hooked.set(tabOf(p), roleOf(p));
    const currentTabs = new Set(ROLES.map((r) => current(r)).filter(Boolean).map(tabOf));
    const list = tabs.map((t) => ({
      id: t.id,
      url: bare(t.url || t.pendingUrl || ''),
      active: !!t.active,
      hook: hooked.has(t.id),
      role: hooked.get(t.id) || tabRoles.get(t.id) || roleOfUrl(t.url || t.pendingUrl || '') || null,
      current: currentTabs.has(t.id),
    }));
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

// ------------------------------------------------------------ the worker's own commands: a role's tab
/** The role's tab: the one the extractor names, its page's, one opened for it, or one on its address. */
async function tabFor(role, tabId) {
  const tabs = await chrome.tabs.query({});
  const byId = (id) => (id === null || id === undefined ? null : tabs.find((t) => t.id === id) || null);
  const port = current(role);
  let t = byId(tabId) || (port && byId(tabOf(port)));
  if (t) return t;
  for (const [id, r] of tabRoles) if (r === role && (t = byId(id))) return t;
  return tabs.find((x) => roleOfUrl(x.url || x.pendingUrl || '') === role) || null;
}

/**
 * tab.open: the role's tab if it has one, else a new one. tab.reload: the role's tab sent back to `url`, or with
 * `fresh`, a new tab on `url` and then the old one closed (new first: the last tab closing would end the browser).
 */
async function tabCommand(id, cmd) {
  const role = ROLES.includes(cmd.page) ? cmd.page : 'calendar';
  try {
    if (typeof cmd.url !== 'string' || roleOfUrl(cmd.url) !== role) throw new Error(`not a ${role} address`);
    let t = await tabFor(role, cmd.tabId);
    let how = 'open';
    if (cmd.kind === 'tab.reload' && t && !cmd.fresh) {
      try {
        t = await chrome.tabs.update(t.id, { url: cmd.url });
        how = 'navigated';
      } catch (e) {
        how = 'closed';
      }
    }
    if (!t || (cmd.kind === 'tab.reload' && how !== 'navigated')) {
      const old = t;
      t = await chrome.tabs.create({ url: cmd.url, active: !!cmd.active });
      how = old ? 'reopened' : 'opened';
      if (old) {
        tabRoles.delete(old.id);
        try {
          await chrome.tabs.remove(old.id);
        } catch (e) {}
      }
    }
    if (tabRoles.get(t.id) !== role) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    tabRoles.set(t.id, role);
    sendUp({ t: 'reply', id, ok: true, result: { tabId: t.id, how } });
    tabsChanged();
  } catch (err) {
    sendUp({ t: 'reply', id, ok: false, error: String((err && err.message) || err) });
  }
}

// ------------------------------------------------------------ the socket
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
    const cmd = msg.cmd || {};
    if (cmd.kind === 'tab.open' || cmd.kind === 'tab.reload') {
      tabCommand(msg.id, cmd);
      return;
    }
    const role = ROLES.includes(cmd.page) ? cmd.page : 'calendar';
    const port = current(role);
    if (!port) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: `${NAMES[role]} is not open in the sandbox` });
      return;
    }
    try {
      port.postMessage(msg);
    } catch (err) {
      sendUp({ t: 'reply', id: msg.id, ok: false, error: `the ${NAMES[role]} page went away` });
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

// ------------------------------------------------------------ the pages
/** A page's frame, up with its port's role; a hook that announces its role sets it. */
function fromPage(port, payload) {
  if (payload && payload.t === 'hook' && payload.role) setRole(port, payload.role);
  sendUp(payload && typeof payload === 'object' && payload.t !== 'reply' ? { ...payload, role: roleOf(port) } : payload);
  if (payload && payload.t === 'hook') tabsChanged();
}

chrome.runtime.onConnect.addListener(async (port) => {
  ports.push(port);
  // Until the config is read (for the tests' origins), frames wait, in order.
  port.onMessage.addListener((payload) => (CONFIG ? fromPage(port, payload) : configLoaded.then(() => fromPage(port, payload))));
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i >= 0) ports.splice(i, 1);
    portRoles.delete(port);
    tabsChanged();
  });
  connect();
  const cfg = await loadConfig();
  if (!portRoles.has(port)) setRole(port, roleOfUrl((port.sender && port.sender.url) || ''));
  tabsChanged();
  // What the hook needs (not the token): which signed-in account, and the test origins it may call in tests.
  try {
    port.postMessage({
      t: 'settings',
      settings: { authuser: String((cfg && cfg.authuser) ?? '0'), testOrigin: (cfg && cfg.testOrigin) || null, testMailOrigin: (cfg && cfg.testMailOrigin) || null },
    });
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status) tabsChanged();
});
chrome.tabs.onActivated.addListener(tabsChanged);
chrome.tabs.onRemoved.addListener((id) => {
  tabRoles.delete(id);
  tabsChanged();
});
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
