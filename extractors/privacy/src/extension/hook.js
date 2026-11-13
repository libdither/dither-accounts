/*
 * MAIN-world content script on privacy.com pages (top frame), at document_start: this browser's passkey for
 * privacy.com. Its passkey half is packages/browser/src/page/webauthn.js, put in below when the extension is copied
 * (docs/passkeys.md): navigator.credentials.create and .get for public-key requests go, as plain data, to the
 * extractor (through content.js and the service worker, which adds the caller's origin as Chromium reports it). The
 * extractor checks the rpId, makes or uses the key and keeps it; the private key never comes into this page.
 *
 *   - create (publicKey): always answered here (that is how Privacy enrolls this browser's passkey).
 *   - get (publicKey, modal): answered here when the extractor holds a credential the request allows; otherwise the
 *     browser's own get runs, as if this authenticator were not there.
 *   - get with mediation "conditional" (passkey autofill), and anything that is not a publicKey request (passwords,
 *     federated, OTP): the browser's own, untouched.
 *
 * It never sees the extractor's token; it only talks to content.js, over the channel in main-world.js (put in below
 * too), which also keeps its wrappers looking native.
 *
 * For the statements pull (docs/privacy.md) it also notes the app's own transactions request (GET /api/v2/transactions,
 * by fetch or XMLHttpRequest): its URL and the headers the app set on it, kept in this page's memory only (pcom.py kept
 * them the same way). On the extractor's word it then answers a few commands, as the page:
 *   page.state    where the page is and what it shows (a passkey button, a code field, a captcha): booleans only
 *   page.passkey  clicks the sign-in page's passkey button (what you would click)
 *   txn.request   the app's transactions request URL (its query names limit, fullInfo, transactionFilter), or null
 *   txn.get       GETs one transactions page with the app's own headers and cookies: [status, body]
 * The headers never leave the page. Plain JS on purpose.
 */
(() => {
  'use strict';
  /*@include main-world@*/
  if (!cloak.once()) return;
  /*@include webauthn@*/

  const post = (payload) => cloak.send(payload);

  cloak.onDown((p) => {
    if (p.t === 'cmd' && typeof p.id === 'string') {
      command(p.cmd || {}).then(
        (result) => post({ t: 'reply', id: p.id, ok: true, result }),
        (e) => post({ t: 'reply', id: p.id, ok: false, error: String((e && e.message) || e).slice(0, 300) }),
      );
    }
  });

  // ------------------------------------------------------------ the app's transactions request (pcom.py on_request)
  const TXN = '/api/v2/transactions';
  const nativeFetch = window.fetch;
  let txnReq = null; // { url, headers }: the first one this page made; never sent anywhere
  function txnUrl(url) {
    try {
      const u = new URL(url, location.href);
      const hostOk = u.hostname.endsWith('privacy.com') || u.hostname === location.hostname;
      return hostOk && u.pathname.replace(/\/+$/, '') === TXN ? u : null;
    } catch (e) {
      return null;
    }
  }
  function note(method, url, headers) {
    if (txnReq || String(method || 'GET').toUpperCase() !== 'GET') return;
    const u = txnUrl(url);
    if (!u) return;
    const h = {};
    for (const [k, v] of headers) {
      const n = String(k).toLowerCase();
      if (n === 'host' || n === 'content-length' || n === 'cookie' || n.startsWith(':')) continue;
      h[n] = String(v);
    }
    txnReq = { url: u.href, headers: h };
  }
  try {
    const wrapped = {
      fetch(input, init) {
        try {
          const req = input instanceof Request ? input : null;
          const headers = new Headers((init && init.headers) || (req ? req.headers : undefined));
          note((init && init.method) || (req && req.method), req ? req.url : String(input), headers.entries());
        } catch (e) {}
        return cloak.apply(nativeFetch, this, arguments);
      },
    }.fetch;
    cloak.replace(window, 'fetch', () => wrapped);
  } catch (e) {}
  try {
    const XP = XMLHttpRequest.prototype;
    const seen = new WeakMap();
    cloak.replace(XP, 'open', (open) => {
      const w = {
        open(method, url) {
          try {
            seen.set(this, { method, url: String(url), headers: [] });
          } catch (e) {}
          return cloak.call(open, this, arguments, w);
        },
      }.open;
      return w;
    });
    cloak.replace(XP, 'setRequestHeader', (setHeader) => {
      const w = {
        setRequestHeader(k, v) {
          try {
            const r = seen.get(this);
            if (r) r.headers.push([k, v]);
          } catch (e) {}
          return cloak.call(setHeader, this, arguments, w);
        },
      }.setRequestHeader;
      return w;
    });
    cloak.replace(XP, 'send', (send) => {
      const w = {
        send() {
          try {
            const r = seen.get(this);
            if (r) note(r.method, r.url, r.headers);
          } catch (e) {}
          return cloak.call(send, this, arguments, w);
        },
      }.send;
      return w;
    });
  } catch (e) {}

  // ------------------------------------------------------------ what the page shows (booleans only)
  function shown(el) {
    try {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
    } catch (e) {
      return false;
    }
  }
  const label = (el) => `${el.innerText || el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.tagName === 'INPUT' ? el.value || '' : ''}`.replace(/\s+/g, ' ').trim();
  function passkeyButton() {
    const all = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')).filter((el) => !el.disabled && shown(el) && /passkey/i.test(label(el)));
    return all.find((el) => /(log|sign)\s*in/i.test(label(el))) || all[0] || null;
  }
  const CAPTCHA = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i;
  function captcha() {
    const frames = Array.from(document.querySelectorAll('iframe')).filter((f) => CAPTCHA.test(f.src || '') && !/size=invisible/.test(f.src || '') && shown(f));
    const boxes = Array.from(document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')).filter(shown);
    const words = /verify (that )?you('| a)re (a )?human|are you a robot|complete the captcha/i.test((document.body && document.body.innerText) || '');
    return frames.length > 0 || boxes.length > 0 || words;
  }
  function inputs() {
    return Array.from(document.querySelectorAll('input')).filter((i) => i.type !== 'hidden' && shown(i));
  }
  function pageState() {
    const ins = inputs();
    const named = (i) => `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''} ${i.autocomplete || ''}`;
    return {
      path: location.pathname,
      ready: document.readyState,
      passkeyButton: !!passkeyButton(),
      passwordInput: ins.some((i) => i.type === 'password'),
      codeInput: ins.some((i) => i.autocomplete === 'one-time-code' || /\b(code|otp|one-time|verification|2fa|tfa|pin)\b/i.test(named(i))),
      captcha: captcha(),
      txnSeen: !!txnReq,
    };
  }

  async function command(c) {
    switch (c.kind) {
      case 'page.state':
        return pageState();
      case 'page.passkey': {
        const b = passkeyButton();
        if (!b) return { clicked: false };
        b.click();
        return { clicked: true };
      }
      case 'tab.go': {
        // The service worker handles tab.go; a worker Chromium kept from an older copy of this extension passes it
        // here instead. Then the page goes itself, on its own origin only.
        const u = new URL(String(c.url || ''), location.href);
        if (u.origin !== location.origin) throw new Error('tab.go from the page: only on its own origin');
        setTimeout(() => location.assign(u.href), 50);
        return { tabId: null, fromPage: true };
      }
      case 'txn.request':
        return txnReq ? { url: txnReq.url } : null;
      case 'txn.get': {
        if (!txnReq) throw new Error('this page has not made its transactions request');
        const u = txnUrl(c.url);
        if (!u || u.origin !== new URL(txnReq.url).origin) throw new Error('not the transactions endpoint');
        const r = await cloak.apply(nativeFetch, window, [u.href, { method: 'GET', headers: txnReq.headers, credentials: 'include' }]);
        return [r.status, await r.text()];
      }
    }
    throw new Error(`unknown page command ${String(c.kind)}`);
  }

  post({ t: 'hook', page: location.origin + location.pathname });
})();
