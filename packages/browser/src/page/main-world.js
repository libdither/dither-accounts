/*
 * What every hook (hook.js, the MAIN-world content script) shares. It is not a file of the extension: the copy step
 * (packages/browser/src/markers.ts) puts it in place of the hook's `include main-world` marker, so each hook runs one
 * copy of it, first, at document_start, before any page script. It keeps out of the page's sight what a hook would
 * otherwise show it:
 *
 *   - The channel to content.js (the ISOLATED world: isolated-world.js). CustomEvents on window, of types made for
 *     this install and account, carrying plain objects (Chromium clones them from one world into the other). A page
 *     gets no `message` event from them, and can only listen for a type it knows. Both ends say hello (a null detail)
 *     when they start, in whichever order Chromium runs them, and the hook holds what it says until content.js has
 *     answered. What comes down is handled in a microtask after the event, so page code a hook calls never finds our
 *     event in window.event.
 *   - Functions a hook puts where the page's own were (fetch, XHR, navigator.credentials, a page module's function)
 *     read like what they replaced (`native`, `replace`, `wrap`): Function.prototype.toString gives the original's
 *     text (native code for a native, the page's source for a page function), with its name and length, a
 *     `prototype` only where the original has one (hooks write wrappers of natives as methods or arrows), and the
 *     original's property attributes. Accessors a hook adds read like native ones (`accessor`). toString itself reads
 *     as native.
 *   - Stack frames. The sourceURL at the end of this file names the script `<anonymous>` in Error.stack (and in a
 *     CallSite's toString and getScriptNameOrSourceURL) instead of chrome-extension://<id>/hook.js. A native that a
 *     wrapper calls and that throws at once (XHR's open and send, toString) throws with the stack the page would have
 *     seen without the wrapper (`call`). CallSite.getFileName() still gives the real URL: V8 makes it read-only.
 *   - `once()`: whether this is the only run of the hook in this page, asked with a cancelable event of our own type
 *     rather than a mark left on window.
 *
 * Its own work uses references it takes now, before the page can replace them (Reflect.apply, the event methods, the
 * WeakMap it keeps its records in). Every global the tests stand in for is read off `window`; with no window.Function
 * (a test's stand-in window), the toString and stack parts are left out.
 *
 * What a page can still see, in spite of this, is listed in docs/page-traces.md.
 */
const cloak = (() => {
  const W = window;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const hasOwn = Object.prototype.hasOwnProperty;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const indexOf = String.prototype.indexOf;
  const lastIndexOf = String.prototype.lastIndexOf;
  const slice = String.prototype.slice;
  const later = queueMicrotask;
  const CE = W.CustomEvent || CustomEvent;
  const detailOf = getOwnPropertyDescriptor(CE.prototype, 'detail').get;
  const preventDefault = (W.Event || Event).prototype.preventDefault;
  const dispatch = W.dispatchEvent;
  const listen = W.addEventListener;
  const F = W.Function;
  const FP = F && F.prototype;
  const Err = W.Error;
  const capture = Err && Err.captureStackTrace;

  // ------------------------------------------------------------ looking native
  const shown = new WeakMap(); // our function -> the text toString gives for it (or a function making that text)
  let toText = FP && FP.toString;
  const nativeText = (name) => 'function ' + name + '() { [native code] }';
  const textOf = (fn) => apply(toText, fn, []);

  /** fn reads like `like`: a function (its text, name and length), or a name, for a native-looking function of it. */
  function native(fn, like, length) {
    if (!FP || typeof fn !== 'function') return fn;
    let name;
    let text;
    if (typeof like === 'function') {
      name = like.name;
      length = like.length;
      text = () => textOf(like);
    } else {
      name = String(like);
      text = nativeText(name);
    }
    try {
      defineProperty(fn, 'name', { value: typeof name === 'string' ? name : '' });
      defineProperty(fn, 'length', { value: typeof length === 'number' ? length : 0 });
    } catch (e) {}
    apply(wmSet, shown, [fn, text]);
    return fn;
  }

  /** What toString gives for fn is `text` (a string, or a function making it), whatever fn's own source. */
  function showAs(fn, text) {
    if (FP) apply(wmSet, shown, [fn, text]);
    return fn;
  }

  /**
   * A stand-in for the page's function `orig` that runs body(this, arguments). It reads like orig, has a prototype
   * only if orig has one (orig's own), and `new` on it builds what orig would.
   */
  function wrap(orig, body) {
    let fn;
    if (typeof orig === 'function' && apply(hasOwn, orig, ['prototype'])) {
      fn = function () {
        return new.target ? construct(orig, arguments, new.target) : body(this, arguments);
      };
      try {
        fn.prototype = orig.prototype;
      } catch (e) {}
    } else {
      fn = {
        f() {
          return body(this, arguments);
        },
      }.f;
    }
    return native(fn, orig);
  }

  /**
   * obj[key] := make(original), reading like the original, with the original's property attributes. Answers a function
   * that puts the original back as it was.
   */
  function replace(obj, key, make) {
    const d = getOwnPropertyDescriptor(obj, key);
    const orig = d && 'value' in d ? d.value : obj[key];
    const fn = native(make(orig), orig);
    defineProperty(obj, key, d && 'value' in d ? { value: fn, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable } : { value: fn, writable: true, enumerable: true, configurable: true });
    return () => {
      if (d) defineProperty(obj, key, d);
      else delete obj[key];
    };
  }

  /** An accessor whose getter and setter read like native ones (`get <key>`, `set <key>`). Pass arrows or methods. */
  function accessor(obj, key, get, set, enumerable) {
    defineProperty(obj, key, {
      get: get && native(get, 'get ' + String(key), 0),
      set: set && native(set, 'set ' + String(key), 1),
      enumerable: !!enumerable,
      configurable: true,
    });
  }

  // ------------------------------------------------------------ stacks
  /** The page set Error.prepareStackTrace: it formats stacks itself, from CallSites. */
  function formatted() {
    const d = getOwnPropertyDescriptor(Err, 'prepareStackTrace');
    return !!d && (!!d.get || typeof d.value === 'function');
  }
  function stackLimit() {
    const d = getOwnPropertyDescriptor(Err, 'stackTraceLimit');
    return d && typeof d.value === 'number' ? d.value : Infinity;
  }
  /**
   * e was thrown by a native that `wrapper` called: give it the stack the page would have seen had it called the
   * native itself. V8 takes the stack again from wrapper's caller (no frame of ours). A JS builtin (toString, unlike a
   * DOM method) also had a frame of its own at the top, `at Object.toString (<anonymous>)`: put it back.
   */
  function scrub(e, wrapper, builtin) {
    if (!capture || e === null || typeof e !== 'object') return;
    try {
      let top = null;
      if (builtin && !formatted()) {
        const s = e.stack;
        const a = apply(indexOf, s, ['\n    at ']);
        if (a >= 0) {
          const b = apply(indexOf, s, ['\n', a + 1]);
          const line = apply(slice, s, [a, b < 0 ? s.length : b]);
          if (apply(lastIndexOf, line, [' (<anonymous>)']) === line.length - 14) top = line;
        }
      }
      capture(e, wrapper);
      if (top === null) return;
      const s = e.stack;
      const h = apply(indexOf, s, ['\n    at ']);
      let rest = h < 0 ? '' : apply(slice, s, [h]);
      let frames = 0;
      for (let i = apply(indexOf, rest, ['\n    at ']); i >= 0; i = apply(indexOf, rest, ['\n    at ', i + 1])) frames++;
      if (frames + 1 > stackLimit() && frames > 0) rest = apply(slice, rest, [0, apply(lastIndexOf, rest, ['\n    at '])]);
      e.stack = (h < 0 ? s : apply(slice, s, [0, h])) + top + rest;
    } catch (x) {}
  }
  /** Call a native from a wrapper: if it throws at once, it throws as if the page had called it. */
  function call(fn, self, args, wrapper) {
    try {
      return apply(fn, self, args);
    } catch (e) {
      scrub(e, wrapper, false);
      throw e;
    }
  }

  if (FP) {
    replace(FP, 'toString', (orig) => {
      const toString = {
        toString() {
          const t = apply(wmGet, shown, [this]);
          if (t !== undefined) return typeof t === 'string' ? t : t();
          try {
            return apply(orig, this, arguments);
          } catch (e) {
            scrub(e, toString, true);
            throw e;
          }
        },
      }.toString;
      return toString;
    });
    toText = FP.toString;
  }

  // ------------------------------------------------------------ the channel
  const UP = '__MARK_up__';
  const DOWN = '__MARK_down__';
  const ONCE = '__MARK_once__';
  const event = (type, init) => new CE(type, init);
  let heard = false; // content.js has said hello
  const held = [];
  const handlers = [];

  function emit(detail) {
    try {
      apply(dispatch, W, [event(UP, { __proto__: null, detail })]);
    } catch (e) {}
  }
  /** To content.js, and on to the extractor. Held until content.js is there. */
  function send(payload) {
    if (heard) emit(payload);
    else if (held.length < 1000) held[held.length] = payload;
  }
  /** fn(payload) for everything that comes down, in a microtask after the event that brought it. */
  function onDown(fn) {
    handlers[handlers.length] = fn;
  }
  apply(listen, W, [
    DOWN,
    (e) => {
      let d;
      try {
        d = apply(detailOf, e, []);
      } catch (x) {
        return;
      }
      if (d === null || d === undefined) {
        // content.js's hello, or its answer to ours.
        if (heard) return;
        heard = true;
        for (let i = 0; i < held.length; i++) emit(held[i]);
        held.length = 0;
        return;
      }
      later(() => {
        for (let i = 0; i < handlers.length; i++) {
          try {
            handlers[i](d);
          } catch (x) {}
        }
      });
    },
  ]);
  emit(null); // hello: a content.js that is already listening answers at once

  /** True for the first run of this hook in the page; false if one is already running (it cancels our event). */
  function once() {
    try {
      if (apply(dispatch, W, [event(ONCE, { __proto__: null, cancelable: true })]) === false) return false;
      apply(listen, W, [ONCE, (e) => apply(preventDefault, e, [])]);
    } catch (e) {}
    return true;
  }

  return { send, onDown, once, native, showAs, wrap, replace, accessor, call, apply, textOf: (fn) => (FP ? textOf(fn) : '') };
})();
//# sourceURL=<anonymous>
