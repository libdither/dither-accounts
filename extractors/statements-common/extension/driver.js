/*
 * The finance kinds' MV3 service worker (venmo, amazon): a tab driver for the extractor, with no DevTools and no
 * automation. It owns the one WebSocket to the local extractor (token from the packaged config.json, which pages cannot
 * read) and does, on the extractor's word, what a person's browser does: open a tab, load a page in it, run one of the
 * kind's page functions in it (chrome.scripting, from page.js: read the page, or make the request the site's own page
 * makes), bring a tab to the front, close it. It also tells the extractor which page each tab is on (origin and path
 * only, never the query or hash).
 *
 *   extractor --ws {t:'cmd', id, cmd}--> this worker --chrome.tabs / chrome.scripting--> the site's tab
 *   extractor <--ws {t:'reply', id, ok, result|error}-- this worker
 *
 * Copied into each kind's extension as sw.js by the extractor at start (statements-common/src/tabs.ts); page.js is
 * the kind's own file and defines self.PAGE = { name: function }. A kind with a passkey (schwab) gets passkeys.js
 * appended to the copy: it adds the command `webauthn.answer` to EXTRA and takes the page hooks' ports.
 */
'use strict';

try {
  importScripts('page.js');
} catch (e) {}
const PAGE = self.PAGE || {};
/** Commands a part appended to this worker adds (passkeys.js): kind -> function(cmd) giving the result. */
const EXTRA = {};

let CONFIG = null;
let ws = null;
let wsReady = false;
const outbox = [];
let backoff = 500;
let lastTabs = '';
let tabsTimer = null;
/** tabId -> { committed, resolve, reject }: a load the extractor waits for. */
const loads = new Map();

async function loadConfig() {
  if (CONFIG) return CONFIG;
  try {
    CONFIG = await (await fetch(chrome.runtime.getURL('config.json'))).json();
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
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
    connect();
  }
}

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
    const list = tabs.map((t) => ({ id: t.id, url: bare(t.url || t.pendingUrl || ''), active: !!t.active, loading: t.status === 'loading' }));
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

// A load is over at the top frame's DOMContentLoaded after a commit (what Playwright's goto waits for).
// A new tab's own about:blank commits late; it is not the page being waited for.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const w = loads.get(d.tabId);
  if (w && !(String(d.url).startsWith('about:') && !w.target.startsWith('about:'))) w.committed = true;
});
chrome.webNavigation.onDOMContentLoaded.addListener((d) => {
  if (d.frameId !== 0) return;
  const w = loads.get(d.tabId);
  if (w && w.committed) {
    loads.delete(d.tabId);
    w.resolve();
  }
});
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId !== 0) return;
  const w = loads.get(d.tabId);
  if (w && d.error !== 'net::ERR_ABORTED') {
    loads.delete(d.tabId);
    w.reject(new Error(`load failed: ${d.error}`));
  }
});

function waitLoad(tabId, ms, target) {
  const prev = loads.get(tabId);
  if (prev) prev.reject(new Error('another load started'));
  let timer;
  const p = new Promise((resolve, reject) => {
    loads.set(tabId, { committed: false, target: String(target || ''), resolve, reject });
    timer = setTimeout(() => {
      loads.delete(tabId);
      reject(new Error(`the page did not load within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  return p.finally(() => clearTimeout(timer));
}

async function tabInfo(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { tabId: t.id, url: t.url || t.pendingUrl || '', status: t.status, active: !!t.active };
}

async function go(tabId, url, ms) {
  const done = waitLoad(tabId, ms || 60000, url);
  await chrome.tabs.update(tabId, { url });
  await done;
  return tabInfo(tabId);
}

async function run(cmd) {
  if (Object.prototype.hasOwnProperty.call(EXTRA, cmd.kind)) return EXTRA[cmd.kind](cmd);
  switch (cmd.kind) {
    case 'tab.open': {
      const t = await chrome.tabs.create({ url: 'about:blank', active: !!cmd.active });
      if (!cmd.url) return tabInfo(t.id);
      return go(t.id, cmd.url, cmd.timeout);
    }
    case 'tab.go':
      return go(cmd.tabId, cmd.url, cmd.timeout);
    case 'tab.get':
      return tabInfo(cmd.tabId);
    case 'tab.activate': {
      await chrome.tabs.update(cmd.tabId, { active: true });
      return tabInfo(cmd.tabId);
    }
    case 'tab.close':
      try {
        await chrome.tabs.remove(cmd.tabId);
      } catch (e) {}
      return { closed: true };
    case 'tab.exec': {
      const fn = PAGE[cmd.fn];
      if (typeof fn !== 'function') throw new Error(`no page function ${cmd.fn}`);
      // The top frame (or the frame frameId names); or, with allFrames, every frame the extension may reach (a sign-in
      // page's frames), each result with its frameId.
      const target = cmd.allFrames ? { tabId: cmd.tabId, allFrames: true } : { tabId: cmd.tabId, frameIds: [Number.isInteger(cmd.frameId) ? cmd.frameId : 0] };
      const res = await chrome.scripting.executeScript({ target, world: cmd.world === 'MAIN' ? 'MAIN' : 'ISOLATED', func: fn, args: cmd.args || [] });
      if (cmd.allFrames) return (res || []).map((r) => ({ frameId: r.frameId, result: r.result }));
      return res && res[0] ? res[0].result : undefined;
    }
  }
  throw new Error(`unknown command ${cmd.kind}`);
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
    run(msg.cmd).then(
      (result) => sendUp({ t: 'reply', id: msg.id, ok: true, result }),
      (err) => sendUp({ t: 'reply', id: msg.id, ok: false, error: String((err && err.message) || err).slice(0, 300) }),
    );
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

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status) tabsChanged();
});
chrome.tabs.onActivated.addListener(tabsChanged);
chrome.tabs.onRemoved.addListener((id) => {
  const w = loads.get(id);
  if (w) {
    loads.delete(id);
    w.reject(new Error('the tab was closed'));
  }
  tabsChanged();
});
chrome.tabs.onCreated.addListener(tabsChanged);

try {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    if (!ws || ws.readyState > 1) connect();
  });
} catch (e) {}

self.addEventListener('activate', () => connect());
connect();
