/* X's hook: the React DevTools hook it installs reads as native code. */
(async () => {
  const { check, finish, text } = PROBE;
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  check('the DevTools hook is there', !!hook && typeof hook === 'object');
  const lengths = { inject: 1, onCommitFiberRoot: 2 };
  for (const k of Object.keys(hook || {})) {
    const f = hook[k];
    if (typeof f !== 'function') continue;
    check(`${k}: toString`, text(f) === `function ${k}() { [native code] }`, text(f).slice(0, 120));
    check(`${k}: name`, f.name === k, f.name);
    check(`${k}: length`, f.length === (lengths[k] || 0), f.length);
    check(`${k}: no prototype`, !('prototype' in f));
    check(`${k}: own keys`, PROBE.same(Object.getOwnPropertyNames(f), ['length', 'name']), Object.getOwnPropertyNames(f));
  }
  check('inject still answers', typeof hook.inject({ version: '19.0.0', rendererPackageName: 'react-dom' }) === 'number');
  await finish();
})();
