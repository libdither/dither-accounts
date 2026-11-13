/*
 * ISOLATED-world content script on discord.com. Its only job is to pass messages between the MAIN-world hook and the
 * service worker (a long-lived chrome.runtime port). It holds no secrets and makes no network calls. The code is
 * packages/browser/src/page/isolated-world.js, put in below when the extension is copied.
 */
(() => {
  'use strict';
  const QUEUE = 0; // frames from the hook while the port is down are dropped
  /*@include isolated-world@*/
})();
