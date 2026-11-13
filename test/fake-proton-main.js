/*
 * The stand-in Proton Mail's lazily loaded "MainContainer" chunk (see fake-proton-app.js): one module that exports only
 * its component, as the live build has it. There the composer, its send functions and the encryption preferences are
 * concatenated inside that module and export nothing; the hook does not look for them (it sends the safe subset
 * itself: docs/proton.md, "Sending"), so this stand-in carries none of them.
 */
(() => {
  'use strict';
  const MainContainer = () => 'MainContainer';
  (globalThis.webpackChunkproton_mail = globalThis.webpackChunkproton_mail || []).push([
    ['main'],
    {
      main(e, t, r) {
        r.d(t, ['default', 0, MainContainer]);
      },
    },
  ]);
})();
