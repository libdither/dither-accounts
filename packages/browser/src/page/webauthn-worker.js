/*
 * A service worker's half of a hook's passkey (docs/passkeys.md). Not a file of the extension: the copy step
 * (packages/browser/src/markers.ts) puts it in place of an `include webauthn-worker` marker in the worker. The worker
 * that includes it has a `sendUp(payload)` to the extractor's WebSocket. No placeholders here: Chromium keeps a
 * worker's script from the profile's first start (packages/browser/src/worker.ts).
 *
 * `passkeys.connect(port, other)` takes a page frame's content-script port (content.js): a passkey request from the
 * page hook ({ t: 'webauthn' }) goes up with where it came from as CHROMIUM reports it for the port, never as the page
 * says it: the frame's origin and page (port.sender.origin, .url), whether it is the top frame (frameId 0), the top
 * frame's page (port.sender.tab.url) and, when the extension has chrome.webNavigation, the origins of every frame above
 * it. That is what the extractor checks the frame and the rpId against and writes into clientDataJSON. Anything else
 * the port says goes to `other`.
 *
 * `passkeys.answer(cmd)` handles the extractor's command `webauthn.answer`: it goes to that tab's frame, the one that
 * asked, nowhere else.
 */
const passkeys = (() => {
  const ports = []; // page frames' ports, oldest first
  const asks = new Map(); // sid -> { tabId, frameId, id }: requests waiting for the extractor
  let asked = 0;

  /** Origin and path, no query or hash; other schemes by scheme and host only. */
  function page(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : `${u.protocol}//${u.host}`;
    } catch (e) {
      return '';
    }
  }
  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return 'null';
    }
  }

  /** The origins of the frames above this one, nearest first, the top last; null when the extension cannot tell. */
  async function ancestors(tabId, frameId) {
    if (!frameId) return [];
    try {
      if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return null;
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const by = new Map((frames || []).map((f) => [f.frameId, f]));
      const out = [];
      let f = by.get(frameId);
      for (let i = 0; f && f.parentFrameId >= 0 && i < 32; i++) {
        const parent = by.get(f.parentFrameId);
        if (!parent) return null;
        out.push(originOf(parent.url));
        f = parent;
      }
      return f && f.parentFrameId < 0 ? out : null;
    } catch (e) {
      return null;
    }
  }

  /** The newest port of that tab and frame (content.js replaces its port every few minutes). */
  function portFor(tabId, frameId) {
    for (let i = ports.length - 1; i >= 0; i--) {
      const s = ports[i].sender || {};
      if (s.tab && s.tab.id === tabId && (s.frameId || 0) === frameId) return ports[i];
    }
    return null;
  }

  async function up(port, payload) {
    const s = port.sender || {};
    if (!s.tab || typeof payload.id !== 'string') return;
    const frameId = s.frameId || 0;
    const sid = `w${++asked}`;
    asks.set(sid, { tabId: s.tab.id, frameId, id: payload.id });
    if (asks.size > 50) asks.delete(asks.keys().next().value);
    const topUrl = s.tab.url || '';
    sendUp({
      t: 'webauthn',
      sid,
      op: payload.op,
      options: payload.options,
      // Chromium's word for this frame, not the page's.
      origin: s.origin || '',
      page: page(s.url || ''),
      top: frameId === 0,
      topPage: page(topUrl),
      topOrigin: topUrl ? originOf(topUrl) : null,
      ancestors: await ancestors(s.tab.id, frameId),
    });
  }

  function connect(port, other) {
    ports.push(port);
    port.onMessage.addListener((payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.t === 'webauthn') return void up(port, payload);
      if (other) other(payload, port);
    });
    port.onDisconnect.addListener(() => {
      const i = ports.indexOf(port);
      if (i >= 0) ports.splice(i, 1);
    });
  }

  /** The extractor's answer, to the frame that asked. Throws when there is none to give it to. */
  function answer(cmd) {
    const a = cmd || {};
    const w = asks.get(a.sid);
    if (!w) throw new Error('no such passkey request');
    asks.delete(a.sid);
    const port = portFor(w.tabId, w.frameId);
    if (!port) throw new Error('the page went away');
    try {
      port.postMessage({ t: 'webauthn.answer', id: w.id, ok: !!a.ok, result: a.result, error: a.error, code: a.code });
    } catch (e) {
      throw new Error('the page went away');
    }
    return { delivered: true };
  }

  return { ports, connect, answer };
})();
