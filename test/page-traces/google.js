/* Google's hook: its fetch and XMLHttpRequest wrappers. */
(async () => {
  const { P, check, native, throwsLikeNative, finish } = PROBE;
  native('fetch', window, P(), 'fetch');
  for (const k of ['open', 'setRequestHeader', 'send']) native(`XMLHttpRequest.prototype.${k}`, XMLHttpRequest.prototype, P().XMLHttpRequest.prototype, k);
  throwsLikeNative(
    'XMLHttpRequest open, bad method',
    () => new XMLHttpRequest().open('bad method', '/'),
    () => new (P().XMLHttpRequest)().open('bad method', '/'),
  );
  throwsLikeNative(
    'XMLHttpRequest send before open',
    () => new XMLHttpRequest().send(),
    () => new (P().XMLHttpRequest)().send(),
  );
  const r = await fetch('/ping', { headers: { authorization: 'SAPISIDHASH 1_x' } });
  check('fetch still works', r.status === 200 && (await r.text()) === 'pong');
  const x = await new Promise((resolve) => {
    const req = new XMLHttpRequest();
    req.open('GET', '/ping');
    req.setRequestHeader('authorization', 'SAPISIDHASH 1_x');
    req.onload = () => resolve(req.responseText);
    req.onerror = () => resolve(null);
    req.send();
  });
  check('XMLHttpRequest still works', x === 'pong');
  await finish();
})();
