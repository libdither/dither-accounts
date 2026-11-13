/*
 * The test extension's hook (test/page-traces.test.ts): it does with what main-world.js gives it what the real hooks
 * do (wrap natives, add accessors to page globals, wrap page functions, talk over the channel), so the probe page can
 * look at each. The service worker is Discord's (it relays every frame both ways).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  const first = cloak.once();
  const second = cloak.once();
  const nativeFetch = window.fetch;
  const fetchWrapper = {
    fetch(input, init) {
      return cloak.apply(nativeFetch, this, arguments);
    },
  }.fetch;
  cloak.replace(window, 'fetch', () => fetchWrapper);
  cloak.replace(XMLHttpRequest.prototype, 'open', (open) => {
    const w = {
      open(method, url) {
        return cloak.call(open, this, arguments, w);
      },
    }.open;
    return w;
  });
  // A native that calls back into page code, with our frame under it.
  cloak.replace(Array.prototype, 'forEach', (forEach) => ({
    forEach(cb) {
      return cloak.apply(forEach, this, arguments);
    },
  }).forEach);
  // A page global behind an accessor of ours (as the webpack and Haste traps are); a function set on it is wrapped.
  let held;
  cloak.accessor(
    window,
    'probeGlobal',
    () => held,
    (v) => {
      held = typeof v === 'function' ? cloak.wrap(v, (self, args) => cloak.apply(v, self, args)) : v;
    },
    true,
  );
  cloak.onDown((p) => {
    if (p.t !== 'cmd') return;
    // Page code called while handling what came down: it must not find our event in window.event.
    let seen = 'no page function';
    try {
      seen = window.probeSeesEvent();
    } catch (e) {}
    cloak.send({ t: 'reply', id: p.id, ok: true, result: { seen, once: [first, second] } });
  });
  cloak.send({ t: 'hook', page: location.pathname });
})();
