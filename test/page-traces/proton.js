/*
 * Proton's hook: its fetch wrapper, and its trap on the webpack runtime (one runtime, a private module cache, as
 * Proton's): no probe chunk left in the list, no Proxy or Symbol on the module table, the factories read as the app's.
 */
(async () => {
  const { P, check, native, like, stackThrough, finish } = PROBE;
  native('fetch', window, P(), 'fetch');
  const r = await fetch('/ping');
  check('fetch still works', r.status === 200);

  // A chunk queued before the runtime, then the runtime, then a chunk after it.
  const early = function (module, exports) {
    exports.early = true;
  };
  (self.webpackChunkproton_mail = self.webpackChunkproton_mail || []).push([['early'], { early }]);
  const factories = {};
  const cache = {};
  function req(id) {
    if (cache[id]) return cache[id].exports;
    const module = (cache[id] = { exports: {} });
    factories[id].call(module.exports, module, module.exports, req);
    return module.exports;
  }
  req.m = factories;
  req.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const installed = {};
  const onPush = (parent, data) => {
    const [ids, mods, run] = data;
    let out;
    if (ids.some((i) => installed[i] !== 0)) {
      for (const k in mods) if (req.o(mods, k)) req.m[k] = mods[k];
      if (run) out = run(req);
    }
    if (parent) parent(data);
    for (const i of ids) installed[i] = 0;
    return out;
  };
  const list = (self.webpackChunkproton_mail = self.webpackChunkproton_mail || []);
  list.forEach(onPush.bind(null, 0));
  list.push = onPush.bind(null, list.push.bind(list));
  const later = (module, exports) => {
    exports.later = 42;
  };
  let inside = null;
  const deep = function (module, exports) {
    inside = PROBE.stackThrough('a module factory under a wrapper of ours', (cb) => cb());
    exports.deep = true;
  };
  (self.webpackChunkproton_mail = self.webpackChunkproton_mail || []).push([['later'], { later, deep }]);

  check('the modules still run', req('early').early === true && req('later').later === 42 && req('deep').deep === true && !!inside);
  const d = Object.getOwnPropertyDescriptor(window, 'webpackChunkproton_mail');
  check('the chunk list global: a plain property again', !!d && 'value' in d && d.writable && d.enumerable && d.configurable && d.value === list, PROBE.shape(d));
  check('no probe chunk left in the list', list.length === 2 && list.every((c) => c[0].every((id) => typeof id === 'string')), list.map((c) => c[0].map(String)));
  check('the module table: a plain object', Object.getPrototypeOf(req.m) === Object.prototype && Object.getOwnPropertySymbols(req.m).length === 0);
  like('a factory (function)', req.m.early, early);
  like('a factory (arrow)', req.m.later, later);
  check('factories carry no symbols', Object.values(req.m).every((f) => Object.getOwnPropertySymbols(f).length === 0));
  PROBE.accessor('the chunk list push', list, 'push');
  const pd = Object.getOwnPropertyDescriptor(list, 'push');
  check('the chunk list push: enumerable, as an assigned one', !!pd && pd.enumerable && pd.configurable);
  check('push reads like the runtime’s own (bound: native code)', PROBE.text(list.push) === 'function () { [native code] }' && list.push.name === 'bound onPush', [PROBE.text(list.push), list.push.name]);
  await finish();
})();
