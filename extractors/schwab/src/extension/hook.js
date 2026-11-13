/*
 * MAIN-world content script on schwab.com pages, in every frame, at document_start: this browser's passkey for
 * schwab.com (docs/schwab.md, docs/passkeys.md). Its whole work is packages/browser/src/page/webauthn.js, put in below
 * when the extension is copied: navigator.credentials.create and .get for public-key requests go, as plain data, to
 * the extractor (through content.js and the service worker, which adds the frame's origin, the top page's and the
 * frames' in between as Chromium reports them). The extractor answers only frames that are schwab.com all the way up,
 * and keeps the key; the private key never comes into this page.
 *
 * Every frame, because Schwab's sign-in widget is served from sws-gateway*.schwab.com and may sit in a frame on
 * www.schwab.com or client.schwab.com. A frame the page's permissions policy does not let use passkeys gets the
 * browser's own call, which refuses as it would.
 *
 * It says nothing else: the page functions that read Schwab's pages and press its controls are page.js, run by the
 * service worker. It never sees the extractor's token; it only talks to content.js, over the channel in main-world.js
 * (put in below too), which also keeps its wrappers looking native. Plain JS on purpose.
 */
(() => {
  'use strict';
  /*@include main-world@*/
  if (!cloak.once()) return;
  /*@include webauthn@*/
  cloak.send({ t: 'hook', page: location.origin + location.pathname });
})();
