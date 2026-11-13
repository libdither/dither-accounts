/*
 * The page's side of test/page-traces.test.ts: what any site's own script could look at, looked at. Loaded first in
 * every probe page's <head>, after our hooks (document_start) and before the page's own script. A same-origin
 * about:blank frame, where no content script of ours runs, gives the pristine natives to compare with.
 *
 * Each probe page calls PROBE.finish(extra) when done: the common checks run, and the result goes to the test, which
 * answers with the next page to go to.
 */
window.PROBE = (() => {
  const kind = location.pathname.split('/')[1];
  const messages = [];
  addEventListener('message', (e) => messages.push(typeof e.data), true);
  const fails = [];
  let realm = null;
  /** The pristine realm (a frame of ours, not the hook's). */
  function P() {
    if (realm) return realm;
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    return (realm = f.contentWindow);
  }
  const check = (what, ok, detail) => {
    if (!ok) fails.push(detail === undefined ? what : `${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  };
  const text = (fn) => Function.prototype.toString.call(fn);
  const shape = (d) => (d ? { value: 'value' in d, get: !!d.get, set: !!d.set, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable } : null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function caught(f) {
    try {
      f();
    } catch (e) {
      return e;
    }
    return null;
  }

  /** A function of ours where owner[key] was, against the pristine realm's: as text, name, length, keys, property. */
  function native(label, owner, pOwner, key) {
    const fn = owner[key];
    const pf = pOwner[key];
    check(`${label}: is a function`, typeof fn === 'function' && typeof pf === 'function');
    if (typeof fn !== 'function' || typeof pf !== 'function') return;
    check(`${label}: toString`, text(fn) === P().Function.prototype.toString.call(pf), text(fn).slice(0, 120));
    check(`${label}: String()`, String(fn) === String(pf), String(fn).slice(0, 120));
    check(`${label}: toString of toString`, text(fn.toString) === P().Function.prototype.toString.call(pf.toString));
    check(`${label}: name`, fn.name === pf.name, fn.name);
    check(`${label}: length`, fn.length === pf.length, fn.length);
    check(`${label}: own keys`, same(Object.getOwnPropertyNames(fn), P().Object.getOwnPropertyNames(pf)), Object.getOwnPropertyNames(fn));
    check(`${label}: own symbols`, Object.getOwnPropertySymbols(fn).length === 0);
    check(`${label}: prototype`, 'prototype' in fn === 'prototype' in pf);
    check(`${label}: property`, same(shape(Object.getOwnPropertyDescriptor(owner, key)), shape(P().Object.getOwnPropertyDescriptor(pOwner, key))), shape(Object.getOwnPropertyDescriptor(owner, key)));
    check(`${label}: not a constructor`, !!caught(() => new fn()) === !!caught(() => new pf()));
  }

  /** An accessor of ours on a page object: get and set read like native ones. */
  function accessor(label, owner, key) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    check(`${label}: an accessor`, !!d && !!d.get && !!d.set, shape(d));
    if (!d || !d.get || !d.set) return;
    check(`${label}: getter text`, text(d.get) === `function get ${key}() { [native code] }`, text(d.get).slice(0, 120));
    check(`${label}: setter text`, text(d.set) === `function set ${key}() { [native code] }`, text(d.set).slice(0, 120));
    check(`${label}: getter name and length`, d.get.name === `get ${key}` && d.get.length === 0, [d.get.name, d.get.length]);
    check(`${label}: setter name and length`, d.set.name === `set ${key}` && d.set.length === 1, [d.set.name, d.set.length]);
    check(`${label}: no prototype`, !('prototype' in d.get) && !('prototype' in d.set));
  }

  /** A function of ours standing in for the page's own `orig`: reads like it. */
  function like(label, fn, orig) {
    check(`${label}: toString`, text(fn) === text(orig), text(fn).slice(0, 120));
    check(`${label}: name and length`, fn.name === orig.name && fn.length === orig.length, [fn.name, fn.length]);
    check(`${label}: prototype`, 'prototype' in fn === 'prototype' in orig);
    check(`${label}: own symbols`, Object.getOwnPropertySymbols(fn).length === 0);
  }

  /**
   * A stack taken in page code that `run` calls through something of ours: neither Error.stack nor the CallSites a
   * page's own Error.prepareStackTrace gets show our script's URL as text (our frame is there, named <anonymous>).
   * (CallSite.getFileName() does give it: V8 keeps that method read-only. docs/page-traces.md.)
   */
  function stackThrough(label, run) {
    let stack = '';
    let files = [];
    run(() => {
      stack = new Error('probe').stack;
      Error.prepareStackTrace = (_e, cs) => cs.map((c) => [String(c.getScriptNameOrSourceURL()), String(c)]);
      files = new Error('probe').stack;
      delete Error.prepareStackTrace;
    });
    check(`${label}: a stack was taken`, !!stack && Array.isArray(files) && files.length > 0);
    check(`${label}: Error.stack`, !/chrome-extension:/.test(stack), stack);
    check(`${label}: CallSites`, files.every((f) => f.every((s) => !/chrome-extension:/.test(s))), files);
    return { stack, files };
  }

  /** A native of ours that throws at once throws as the native does: the same error, the page's frames only. */
  function throwsLikeNative(label, f, pf) {
    const e = caught(f);
    const pe = caught(pf);
    check(`${label}: throws`, !!e && !!pe);
    if (!e || !pe) return;
    check(`${label}: same error`, e.name === pe.name && e.message === pe.message, [e.name, e.message]);
    check(`${label}: no frame of ours`, !/chrome-extension:|<anonymous>/.test(e.stack), e.stack);
    check(`${label}: the page's frame first`, String(e.stack).split('\n')[1].includes(location.origin), e.stack);
  }

  function common() {
    check('no window message', messages.length === 0, messages);
    check('no symbols on window', Object.getOwnPropertySymbols(window).length === 0, Object.getOwnPropertySymbols(window).map(String));
    check('Error has no new properties', same(Object.getOwnPropertyNames(Error), P().Object.getOwnPropertyNames(P().Error)), Object.getOwnPropertyNames(Error));
    native('Function.prototype.toString', Function.prototype, P().Function.prototype, 'toString');
    // toString's own TypeError, as V8 throws it: its builtin frame, then the caller's.
    const e = caught(() => Function.prototype.toString.call({}));
    const pe = caught(() => P().Function.prototype.toString.call({}));
    check('toString error', !!e && !!pe && e.name === pe.name && e.message === pe.message, e && [e.name, e.message]);
    if (e && pe) {
      const [line1, line2] = String(e.stack).split('\n').slice(1);
      check('toString error: the builtin frame', line1 === String(pe.stack).split('\n')[1], e.stack);
      check("toString error: then the page's", String(line2).includes(location.origin), e.stack);
    }
    // A function a page has no business finding odd: Object.create of one of ours still refuses toString.
    check('toString on an object made from a function', !!caught(() => text(Object.create(fetch))));
  }

  async function finish(extra) {
    // Anything the hook posted at document_start would have arrived by now.
    await new Promise((r) => setTimeout(r, 300));
    try {
      common();
    } catch (e) {
      fails.push(`common checks threw: ${e && e.stack}`);
    }
    const res = await fetch(`/result/${kind}`, { method: 'POST', body: JSON.stringify({ fails, extra: extra || null }) });
    const { next } = await res.json();
    if (next) location.assign(next);
  }

  return { P, check, native, accessor, like, stackThrough, throwsLikeNative, caught, text, shape, same, finish, fails, kind };
})();
