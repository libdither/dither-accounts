/* The shared mechanism (packages/browser/src/page), through the test extension's hook (test/page-traces/ext). */
(async () => {
  const { P, check, native, accessor, like, stackThrough, throwsLikeNative, caught, finish } = PROBE;
  // What the hook calls back into while it handles something that came down from the extension.
  window.probeSeesEvent = () => String(window.event && window.event.type);

  native('fetch', window, P(), 'fetch');
  native('XMLHttpRequest.prototype.open', XMLHttpRequest.prototype, P().XMLHttpRequest.prototype, 'open');
  native('Array.prototype.forEach', Array.prototype, P().Array.prototype, 'forEach');
  throwsLikeNative(
    'XMLHttpRequest open, bad method',
    () => new XMLHttpRequest().open('bad method', '/'),
    () => new (P().XMLHttpRequest)().open('bad method', '/'),
  );
  stackThrough('a page callback under a native of ours', (cb) => [1].forEach(cb));
  const r = await fetch('/ping');
  check('fetch still works', r.status === 200 && (await r.text()) === 'pong');
  const failed = await fetch('http://a b/').then(
    () => null,
    (e) => e,
  );
  check('a failed fetch: no extension URL in its stack', !!failed && !/chrome-extension:/.test(failed.stack), failed && failed.stack);

  // An accessor of ours on a page global, and a page function it wraps once the page sets it.
  accessor('probeGlobal', window, 'probeGlobal');
  function pageFn(a, b) {
    this.made = true;
    return a + b;
  }
  window.probeGlobal = pageFn;
  const w = window.probeGlobal;
  check('the wrapper is not the page function', w !== pageFn);
  like('a wrapped page function', w, pageFn);
  check('the wrapper calls through', w(1, 2) === 3);
  check('new on the wrapper builds what the page function builds', new w(1, 2) instanceof pageFn);
  const arrow = (x) => x;
  window.probeGlobal = arrow;
  like('a wrapped arrow', window.probeGlobal, arrow);
  check('a wrapped arrow is no constructor', !!caught(() => new window.probeGlobal()));
  stackThrough('a page function under a wrapper of ours', (cb) => {
    window.probeGlobal = cb;
    window.probeGlobal();
  });
  await finish();
})();
