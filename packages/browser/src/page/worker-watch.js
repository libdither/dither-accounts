/*
 * A service worker's side of telling a silent page apart (packages/browser/src/silence.ts). Not a file of the
 * extension: the copy step (markers.ts) puts it in place of a worker's `include worker-watch` marker. It must hold no
 * placeholder: Chromium keeps running the worker it first registered (markers.ts, worker.ts), and the worker is hashed
 * with this in it, so a change here makes the profile take the new worker.
 *
 *   workerWatch.got(sendUp, id)                      after handing a command to a page's port: `got` at 'worker'
 *   workerWatch.answer(sendUp, id, tabId, extra)     a `tab.state` command: how Chromium sees the tab
 *
 * The tab's address is its origin and a path template (segments with digits or long ones as `*`): no query, no ids.
 */
const workerWatch = (() => {
  function template(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//${u.host}`;
      const path = u.pathname
        .split('/')
        .map((s) => (/\d/.test(s) || s.length > 24 ? '*' : s))
        .join('/');
      return u.origin + path;
    } catch (e) {
      return '';
    }
  }
  async function tab(tabId) {
    if (typeof tabId !== 'number') return { tabId: null };
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch (e) {
      return { tabId, gone: true };
    }
    return {
      tabId: t.id,
      url: template(t.url || t.pendingUrl || ''),
      status: t.status || null,
      active: !!t.active,
      discarded: !!t.discarded,
      frozen: typeof t.frozen === 'boolean' ? t.frozen : null,
      audible: !!t.audible,
    };
  }
  return {
    template,
    tab,
    got(send, id) {
      try {
        send({ t: 'got', id, at: 'worker' });
      } catch (e) {}
    },
    async answer(send, id, tabId, extra) {
      try {
        send({ t: 'reply', id, ok: true, from: 'worker', result: { ...(await tab(tabId)), ...(extra || {}) } });
      } catch (err) {
        send({ t: 'reply', id, ok: false, from: 'worker', error: String((err && err.message) || err).slice(0, 200) });
      }
    },
  };
})();
