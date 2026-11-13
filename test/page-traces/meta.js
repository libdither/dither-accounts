/* Meta's hook: its traps on the Haste module system's globals (__d, __onAfterModuleFactory), and the __d wrapper. */
(async () => {
  const { check, accessor, like, stackThrough, text, finish } = PROBE;
  const defined = [];
  function __d(name, deps, factory, flags) {
    defined.push(name);
  }
  window.__d = __d;
  window.__onAfterModuleFactory = null;
  accessor('__d', window, '__d');
  accessor('__onAfterModuleFactory', window, '__onAfterModuleFactory');
  for (const k of ['__d', '__onAfterModuleFactory']) check(`${k}: enumerable, as an assigned global`, Object.getOwnPropertyDescriptor(window, k).enumerable === true);
  check('__d is wrapped', window.__d !== __d);
  like('__d', window.__d, __d);
  window.__d('ProbeModule', [], () => {}, 0);
  check('__d still defines', defined.includes('ProbeModule'));
  stackThrough('the page’s __d under the wrapper', (cb) => {
    window.__d = function __d() {
      cb();
    };
    window.__d();
  });
  const after = window.__onAfterModuleFactory;
  check('__onAfterModuleFactory reads like a bound function when the page set none', text(after) === 'function () { [native code] }' && !('prototype' in after), text(after).slice(0, 120));
  function theirs(record) {}
  window.__onAfterModuleFactory = theirs;
  // (It stays one function, so it keeps having no prototype: Meta's module system only ever sets null.)
  const now = window.__onAfterModuleFactory;
  check('__onAfterModuleFactory, once the page set one, reads like it', text(now) === text(theirs) && now.name === theirs.name && now.length === theirs.length, [text(now).slice(0, 80), now.name, now.length]);
  await finish();
})();
