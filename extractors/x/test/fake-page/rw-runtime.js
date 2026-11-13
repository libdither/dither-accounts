/*
 * The fake responsive-web's webpack runtime (test/fake-x.ts serves it as is, a classic script, as x.com's runtime is):
 * modules (`req.m`), the cache (`req.c`), exports (`req.d`, getters or [name, 0, value] triples), `req.dn` (X's own,
 * it gives a function back), chunk file names (`req.u`), lazy chunks (`req.e`, a script tag per chunk) and the chunk
 * list `webpackChunk_twitter_responsive_web`, whose push runs each chunk's function with the require, as webpack 5's
 * JSONP runtime does.
 */
(() => {
  var modules = {};
  var cache = {};
  function req(id) {
    var c = cache[id];
    if (c !== undefined) return c.exports;
    var m = (cache[id] = { exports: {} });
    modules[id].call(m.exports, m, m.exports, req);
    return m.exports;
  }
  req.m = modules;
  req.c = cache;
  req.d = function (exports, def) {
    if (Array.isArray(def)) {
      for (var i = 0; i < def.length; i += 3) {
        var v = def[i + 2];
        Object.defineProperty(exports, def[i], { enumerable: true, get: ((x) => () => x)(v) });
      }
      return;
    }
    for (var k in def) if (!Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, { enumerable: true, get: def[k] });
  };
  req.r = function (exports) {
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    Object.defineProperty(exports, '__esModule', { value: true });
  };
  req.dn = function (f) {
    return f;
  };
  req.p = '/responsive-web/client-web/';
  var names = { 9001: 'bundle.Notifications', 9002: 'shared~bundle.Notifications~bundle.NotificationDetail', 9003: 'bundle.Bookmarks', 9004: 'shared~bundle.QuoteTweetActivity~bundle.TweetActivity', 9005: 'bundle.TweetActivity' };
  var hashes = { 9001: 'f4ke9001c0ffee12', 9002: 'f4ke9002c0ffee34', 9003: 'f4ke9003c0ffee56', 9004: 'f4ke9004c0ffee78', 9005: 'f4ke9005c0ffee9a' };
  req.u = function (id) {
    return '' + (names[id] || id) + '.' + hashes[id] + 'a.js';
  };
  var installed = { 8000: 0 }; // the runtime chunk itself
  req.e = function (id) {
    var have = installed[id];
    if (have === 0) return Promise.resolve();
    if (have) return have[2];
    var p = new Promise(function (res, rej) {
      installed[id] = [res, rej];
    });
    installed[id][2] = p;
    var s = document.createElement('script');
    s.src = req.p + req.u(id);
    s.onerror = function () {
      var x = installed[id];
      installed[id] = undefined;
      if (x) x[1](new Error('Loading chunk ' + id + ' failed.'));
    };
    document.head.appendChild(s);
    return p;
  };
  function jsonp(parent, data) {
    var ids = data[0];
    var more = data[1];
    var runtime = data[2];
    var result;
    if (ids.some((id) => installed[id] !== 0)) {
      for (var k in more) modules[k] = more[k];
      if (runtime) result = runtime(req);
    }
    if (parent) parent(data);
    for (var i = 0; i < ids.length; i++) {
      var x = installed[ids[i]];
      if (x) x[0]();
      installed[ids[i]] = 0;
    }
    return result;
  }
  var list = (self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []);
  list.forEach(jsonp.bind(null, 0));
  list.push = jsonp.bind(null, list.push.bind(list));
})();
