/*
 * ISOLATED-world content script on the Messenger or Instagram page. Its only job is to pass messages between the MAIN-world hook and the
 * service worker (a long-lived chrome.runtime port). It holds no secrets and makes no network calls. The code is
 * packages/browser/src/page/isolated-world.js, put in below when the extension is copied.
 */
(() => {
  'use strict';
  const QUEUE = 500; // frames from the hook kept while the port is down
  /*@include isolated-world@*/
})();
