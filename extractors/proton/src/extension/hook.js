/*
 * MAIN-world content script on mail.proton.me, at document_start. Never injected into account.proton.me (the sign-in
 * pages run nothing of ours).
 *
 * It (a) watches the Mail app's own calls to its API (/api/…, fetch) and keeps only the values of the headers that say
 * which app is calling (accept, x-pm-appversion, x-pm-locale), the names of the others, and how the calls fare (their
 * statuses): never bodies, responses, cookies, the session id or tokens; (b) reads the app's persisted session for this
 * page (localStorage `ps-<localID>`, the localID being the /u/<n>/ in the address); (c) answers `api`, a call to
 * Proton's API made as the app makes them: the page's cookies, the app's own headers copied, and x-pm-uid from the
 * persisted session; and `storage`, the persisted session's sealed blob and version, which the extractor opens with the
 * ClientKey the API gives it (docs/proton.md). The session id (UID) stays in this page.
 *
 * It also (d) hooks the app's own modules, as the Discord hook does Discord's: it grabs webpack's require by pushing a
 * chunk onto the app's `webpackChunkproton_mail`, records each module's exports as the app's own code loads them
 * (Proton's runtime keeps its module cache private), and finds by shape, never by module id: the CryptoProxy the app
 * encrypts and decrypts with, the object holding the app's own API caller (its thunk argument), the app's Redux store
 * (on the React tree), and the app's choice of an address's keys. With them it answers `pagekeys` and `decrypt`
 * (decrypting through the app's own crypto proxy with the app's own keys, when the extractor cannot open the keys from
 * the saved session) and `send`: the safe subset of what Proton's composer sends (Proton users, encrypted to their
 * key; outside addresses with no key, in the clear), in Proton's own formats, and a refusal before anything is made
 * for every other case (docs/proton.md, "Sending"). Key material stays in the page: only plaintext that was asked for,
 * counts and ids leave it.
 *
 * It never refreshes the session itself: on a 401 it waits for the app to refresh (the app refreshes when its own
 * calls get a 401, under its own cross-tab lock) and tries once more. It never sees the extractor's token; it only
 * talks to content.js, over the channel in main-world.js (put in below when the extension is copied), which also keeps
 * its fetch wrapper and module traps looking like what they stand in for. Plain JS on purpose.
 */
(() => {
  'use strict';
  /*@include main-world@*/
  const nativeFetch = window.fetch;
  const then = Promise.prototype.then;
  /** Headers whose values say which client is calling (no secrets); copied onto our calls. */
  const COPY = ['accept', 'x-pm-appversion', 'x-pm-locale'];
  const HEADERS_WAIT_MS = 20000;
  const REFRESH_WAIT_MS = 45000;

  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg });

  // ------------------------------------------------------------ the app's own calls
  const app = {
    headers: null, // { accept, x-pm-appversion, x-pm-locale } as the app last sent them
    names: [], // every header name the app's calls carry
    uid: null, // x-pm-uid as the app sends it: compared with the persisted session's, never posted
    calls: 0,
    lastStatus: null,
    lastOkAt: 0,
    refreshOkAt: 0,
    refreshes: 0,
  };

  function headerEntries(h) {
    const out = [];
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => out.push([String(k).toLowerCase(), String(v)]));
      else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out.push([String(k).toLowerCase(), String(v)]);
    } catch (e) {}
    return out;
  }

  function apiPath(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith('/api/') ? u.pathname : null;
    } catch (e) {
      return null;
    }
  }

  /** A call of the app's to its API: the headers it sent. Its path, or null for any other request. */
  function noteCall(input, init) {
    let path = null;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      path = apiPath(url);
      if (path) {
        const entries = [...(input instanceof Request ? headerEntries(input.headers) : []), ...headerEntries(init && init.headers)];
        const copied = {};
        for (const [k, v] of entries) {
          if (COPY.includes(k)) copied[k] = v;
          if (k === 'x-pm-uid') app.uid = v;
        }
        if (copied['x-pm-appversion']) app.headers = copied;
        const names = [...new Set([...app.names, ...entries.map(([k]) => k)])].sort();
        if (names.length !== app.names.length) app.names = names.slice(0, 40);
        app.calls++;
      }
    } catch (e) {}
    return path;
  }
  // fetch rejects, never throws, and a failed fetch's stack is taken when it is called: one frame of ours, no more.
  const fetchWrapper = {
    fetch(input, init) {
      const path = noteCall(input, init);
      const p = cloak.apply(nativeFetch, this, arguments);
      if (path) watchCall(p, path);
      return p;
    },
  }.fetch;
  cloak.replace(window, 'fetch', () => fetchWrapper);
  function watchCall(p, path) {
    cloak.apply(then, p, [
      (res) => {
        app.lastStatus = res.status;
        if (res.ok) {
          app.lastOkAt = Date.now();
          if (/\/auth\/(v4\/)?refresh$/.test(path)) {
            app.refreshOkAt = Date.now();
            app.refreshes++;
          }
        }
        sessionSoon();
      },
      () => {},
    ]);
  }

  // ------------------------------------------------------------ the persisted session
  function localID() {
    const m = location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return m ? Number(m[1]) : null;
  }
  function persisted(id) {
    if (id === null) return null;
    try {
      const v = localStorage.getItem('ps-' + id);
      const j = v ? JSON.parse(v) : null;
      return j && typeof j === 'object' ? j : null;
    } catch (e) {
      return null;
    }
  }
  function sessionCount() {
    try {
      return Object.keys(localStorage).filter((k) => /^ps-\d+$/.test(k)).length;
    } catch (e) {
      return 0;
    }
  }

  let lastSession = '';
  let sessionTimer = null;
  // Say nothing about the session until the page's own scripts have run: the app writes ps-<n> before it lands on
  // /u/<n>/, but a page still parsing has not run anything yet.
  let loaded = document.readyState !== 'loading';
  if (!loaded)
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        loaded = true;
        session(false);
      },
      { once: true },
    );
  function sessionSoon() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => session(false), 300);
  }
  function session(force) {
    if (!loaded) return;
    const id = localID();
    const ps = persisted(id);
    const sessions = sessionCount();
    const s = {
      t: 'session',
      page: location.origin + location.pathname,
      localID: id,
      // On /u/<n>/ with ps-<n>: signed in. Off /u/ (the app between pages, or taking over a sign-in): unknown while any
      // session is kept, signed out when none is.
      signedIn: id !== null ? !!(ps && ps.UID) : sessions ? null : false,
      persistent: ps ? ps.persistent !== false : null,
      payloadVersion: ps ? ps.payloadVersion || 1 : null,
      sessions,
      appCalls: app.calls,
      appLastStatus: app.lastStatus,
      appRefreshes: app.refreshes,
      appVersion: app.headers ? app.headers['x-pm-appversion'] : null,
      appHeaders: app.names,
      uidMatches: ps && ps.UID && app.uid ? app.uid === ps.UID : null,
    };
    const k = JSON.stringify(s);
    if (k === lastSession && !force) return;
    lastSession = k;
    post(s);
  }

  // ------------------------------------------------------------ calls
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(f, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return true;
      await sleep(250);
    }
    return f();
  }

  function toBase64(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(s) {
    const bin = atob(String(s || ''));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function urlOf(c) {
    const path = String(c.path || '');
    if (!/^[a-z0-9]+\/v\d+\/[A-Za-z0-9_\-/=.%]*$/.test(path) && !/^auth\/[a-z0-9/]+$/.test(path)) throw new Error('api: not an API path');
    const u = new URL('/api/' + path, location.origin);
    for (const [k, v] of Object.entries(c.query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k + '[]', String(item));
      else u.searchParams.append(k, String(v));
    }
    return u.href;
  }

  async function once(c, uid) {
    const headers = { ...app.headers, 'x-pm-uid': uid };
    if (c.body !== undefined) headers['content-type'] = 'application/json;charset=utf-8';
    // As the app's own fetch: same origin, its cookies, follow redirects.
    const res = await cloak.apply(nativeFetch, window, [
      urlOf(c),
      {
        method: c.method || 'GET',
        headers,
        body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
        mode: 'cors',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
      },
    ]);
    const out = { status: res.status, retryAfter: res.headers.get('retry-after') };
    if (c.binary && res.ok) {
      out.base64 = toBase64(await res.arrayBuffer());
      return out;
    }
    const text = await res.text();
    try {
      out.json = text ? JSON.parse(text) : null;
    } catch (e) {
      out.text = text.slice(0, 500);
    }
    return out;
  }

  async function api(c) {
    const ps = persisted(localID());
    if (!ps || !ps.UID) throw new Error('not signed in on this page');
    if (!app.headers && !(await waitFor(() => !!app.headers, HEADERS_WAIT_MS))) throw new Error('the Mail page has made no API calls of its own yet');
    let r = await once(c, ps.UID);
    if (r.status === 401) {
      // The access token ran out. The app refreshes it when its own calls see the 401; wait for one of them to work.
      const t = Date.now();
      log('info', 'api: 401; waiting for the page to refresh its session');
      if (await waitFor(() => app.lastOkAt > t || app.refreshOkAt > t, REFRESH_WAIT_MS)) {
        const again = persisted(localID());
        r = await once(c, (again && again.UID) || ps.UID);
      }
      r.waitedForRefresh = true;
    }
    return r;
  }

  /** The sealed blob and how it was sealed: opened by the extractor with the ClientKey, never here. */
  function storage() {
    const id = localID();
    const ps = persisted(id);
    if (!ps || !ps.UID) throw new Error('not signed in on this page');
    return { localID: id, UserID: ps.UserID || '', blob: ps.blob || '', payloadVersion: ps.payloadVersion || 1, persistent: ps.persistent !== false, offline: !!ps.offlineKeySalt };
  }

  // ------------------------------------------------------------ the app's modules
  // Proton's runtime (one, `runtimeChunk: 'single'`) keeps its module cache private: `__webpack_require__.c` is not
  // there. So the hook takes webpack's require from a probe chunk, as the Discord hook does, and wraps each module
  // factory before it first runs, keeping the module object, whose exports it reads later: those already in
  // `__webpack_require__.m` when the probe gets the require, and each later chunk's as the chunk list's push takes it in.
  // It never runs a module itself. Nothing it leaves is marked: the wrappers read like the factories they wrap, the
  // probe chunk leaves the list again, and the list's global is a plain property once the runtime has made it.
  const CHUNKS = 'webpackChunkproton_mail';
  const requires = new Set();
  /** { module, factory } for every module the app has run since the hook went in. */
  const records = [];
  /** The factory wrappers we made: kept here, never marked on the page's objects. */
  const wrappers = new WeakSet();
  const hasOwn = Object.prototype.hasOwnProperty;
  const own = (o, k) => cloak.apply(hasOwn, o, [k]);

  /** f, wrapped to keep its module object; it reads like f (cloak.wrap: its source, name and length). */
  function wrapFactory(f) {
    if (typeof f !== 'function' || wrappers.has(f)) return f;
    const w = cloak.wrap(f, (self, args) => {
      const out = cloak.apply(f, self, args);
      try {
        const module = args[0];
        if (module && typeof module === 'object') records.push({ module, factory: f });
      } catch (e) {}
      return out;
    });
    wrappers.add(w);
    return w;
  }
  function wrapAll(mods) {
    if (!mods || typeof mods !== 'object') return;
    for (const k of Object.keys(mods)) {
      try {
        const f = mods[k];
        if (typeof f === 'function' && !wrappers.has(f)) mods[k] = wrapFactory(f);
      } catch (e) {}
    }
  }
  /**
   * The runtime's push, as the chunk list hands it out: it wraps a chunk's factories before the runtime copies them
   * into `__webpack_require__.m`. Reads like the runtime's own (a bound function: native code).
   */
  function wrapPush(push) {
    if (typeof push !== 'function') return push;
    const w = {
      push(chunk) {
        try {
          if (Array.isArray(chunk)) wrapAll(chunk[1]);
        } catch (e) {}
        return cloak.apply(push, this, arguments);
      },
    }.push;
    return cloak.native(w, push);
  }
  /** Down the push chain: every runtime on it hands the probe its require. Then out of the page's chunk list again. */
  function probe(chunks) {
    const chunk = [
      [Symbol()],
      {},
      (r) => {
        if (typeof r === 'function' && r.m && !requires.has(r)) {
          requires.add(r);
          wrapAll(r.m);
        }
      },
    ];
    try {
      chunks.push(chunk);
    } catch (e) {
      log('warn', 'modules: the probe chunk failed');
    }
    try {
      const i = chunks.lastIndexOf(chunk);
      if (i >= 0) chunks.splice(i, 1);
    } catch (e) {}
  }
  function installWebpackHook() {
    const hooked = new WeakSet();
    const hookArray = (chunks) => {
      if (!chunks || typeof chunks !== 'object' || hooked.has(chunks)) return;
      hooked.add(chunks);
      // Chunks queued before the runtime came: their factories are not installed yet.
      try {
        for (const c of chunks) if (Array.isArray(c)) wrapAll(c[1]);
      } catch (e) {}
      // The runtime assigns its push: an accessor (enumerable, as the assigned property is) that sees it happen.
      let shown = chunks.push;
      cloak.accessor(
        chunks,
        'push',
        () => shown,
        (fn) => {
          shown = wrapPush(fn);
          probe(chunks);
        },
        true,
      );
    };
    const stored = window[CHUNKS];
    if (stored) {
      if (own(stored, 'push')) probe(stored);
      hookArray(stored);
      return;
    }
    // Until the runtime makes the list. Then the global is the page's own plain property again: the runtime and every
    // chunk script after it keep the same array.
    let early;
    try {
      cloak.accessor(
        window,
        CHUNKS,
        () => early,
        (v) => {
          early = v;
          if (!v || typeof v !== 'object') return;
          Object.defineProperty(window, CHUNKS, { value: v, writable: true, enumerable: true, configurable: true });
          hookArray(v);
        },
        true,
      );
    } catch (e) {
      log('warn', 'modules: could not watch the chunk list');
    }
  }
  installWebpackHook();

  /** A module's exports; an async module's exports once it has settled. */
  function exportsOf(module) {
    let exp;
    try {
      exp = module.exports;
    } catch (e) {
      return null;
    }
    if (exp && typeof exp.then === 'function') {
      try {
        for (const s of Object.getOwnPropertySymbols(exp)) if (String(s.description || '').includes('webpack exports')) return exp[s];
      } catch (e) {}
      return null;
    }
    return exp;
  }
  // Some objects (translation bundles) answer every key: they would pass any shape test.
  function answersAnyKey(v) {
    try {
      return v['__MARK_noSuchKey__'] !== undefined;
    } catch (e) {
      return true;
    }
  }
  function* candidates(from) {
    const seen = new Set();
    for (let i = from; i < records.length; i++) {
      const rec = records[i];
      const exp = exportsOf(rec.module);
      if (!exp || (typeof exp !== 'object' && typeof exp !== 'function') || exp === window) continue;
      const vals = [exp];
      let keys = [];
      try {
        keys = Object.keys(exp);
      } catch (e) {}
      if (keys.length <= 300)
        for (const k of keys) {
          try {
            vals.push(exp[k]);
          } catch (e) {
            /* an export not initialised yet */
          }
        }
      for (const v of vals) {
        if (!v || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v) || answersAnyKey(v)) continue;
        seen.add(v);
        yield [v, rec];
      }
    }
  }

  const sources = new WeakMap();
  function src(f) {
    let s = sources.get(f);
    if (s === undefined) {
      try {
        s = Function.prototype.toString.call(f);
      } catch (e) {
        s = '';
      }
      sources.set(f, s);
    }
    return s;
  }
  const isFn = (v) => typeof v === 'function';
  const isObj = (v) => !!v && typeof v === 'object';
  const hasAll = (f, tokens) => {
    const s = src(f);
    return tokens.every((t) => s.includes(t));
  };

  /**
   * What the hook looks for, by shape (WebClients names in brackets; docs/proton.md says where each one is):
   *   CryptoProxy            the app's crypto proxy (@protontech/crypto's CryptoProxy)
   *   AppApi                 the app's thunk argument, holding its API caller and its session (extraThunkArguments)
   *   Store                  the app's Redux store (on the React tree, not a module)
   *   AddressKeysByUsage     an address's keys as the app picks them for decrypting, encrypting, signing
   *                          (getAddressKeysByUsageThunk)
   * That is all sending needs too. The composer's own send functions (getEncryptionPreferencesThunk,
   * getSendPreferences, generateTopPackages, attachSubPackages, encryptPackages, sendFormatter) are not looked for:
   * the live build folds them into one module that exports nothing, and `send` below does their part itself for the
   * cases it takes.
   */
  const FINDERS = {
    CryptoProxy: (v) => isObj(v) && ['setEndpoint', 'encryptMessage', 'decryptMessage', 'generateSessionKey', 'encryptSessionKey', 'decryptSessionKey', 'importPublicKey'].every((k) => isFn(v[k])),
    AppApi: (v) => isObj(v) && isFn(v.api) && isObj(v.authentication) && isFn(v.authentication.getUID) && isFn(v.authentication.getLocalID),
    AddressKeysByUsage: (v) => isFn(v) && v.length === 1 && hasAll(v, ['withV6SupportForEncryption', 'withV6SupportForSigning', 'AddressID']),
  };
  const NAMES = ['CryptoProxy', 'AppApi', 'Store', 'AddressKeysByUsage'];
  const mod = {};
  let scanned = 0;

  function resolveExports() {
    const missing = Object.keys(FINDERS).filter((k) => !mod[k]);
    if (!missing.length) return;
    // Modules already looked at cannot gain exports later, except async ones and values set after they ran (the
    // thunk argument is filled in after sign-in): look at everything again while those are missing.
    const from = missing.includes('AppApi') || missing.includes('CryptoProxy') ? 0 : scanned;
    const upTo = records.length;
    for (const [v] of candidates(from)) {
      for (let i = missing.length - 1; i >= 0; i--) {
        let hit = false;
        try {
          hit = FINDERS[missing[i]](v);
        } catch (e) {}
        if (hit) mod[missing.splice(i, 1)[0]] = v;
      }
      if (!missing.length) break;
    }
    scanned = upTo;
  }

  /** The app's store, from the React tree: its provider's `store`. Checked against the thunk argument when known. */
  const isStore = (s) => isObj(s) && isFn(s.dispatch) && isFn(s.getState) && isFn(s.subscribe);
  function storeFromTree() {
    const roots = [];
    try {
      const add = (el) => el && !roots.includes(el) && roots.push(el);
      add(document.querySelector('.app-root'));
      add(document.getElementById('root'));
      for (const el of document.body ? Array.from(document.body.children).slice(0, 50) : []) add(el);
    } catch (e) {}
    for (const el of roots) {
      let key;
      try {
        key = Object.keys(el).find((k) => k.startsWith('__reactContainer$'));
      } catch (e) {}
      if (!key) continue;
      const stack = [el[key]];
      for (let n = 0; stack.length && n < 50000; n++) {
        const f = stack.pop();
        if (!isObj(f)) continue;
        let s = null;
        try {
          s = f.memoizedProps && f.memoizedProps.store;
        } catch (e) {}
        if (isStore(s)) return s;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    return null;
  }
  /** What the store hands its thunks (redux-thunk's extra argument): the app's API caller lives there. */
  function thunkExtra(store) {
    try {
      const extra = store.dispatch((_d, _g, x) => x);
      return FINDERS.AppApi(extra) ? extra : null;
    } catch (e) {
      return null;
    }
  }
  function resolveStore() {
    if (mod.Store) return;
    const s = storeFromTree();
    if (!s) return;
    const extra = thunkExtra(s);
    if (!extra) return; // a store without the app's thunk argument is not the app's
    mod.Store = s;
    // The thunk argument this store hands its thunks is the one the app's code calls the API with.
    mod.AppApi = extra;
  }

  function moduleCount() {
    let n = 0;
    for (const r of requires)
      try {
        n += Object.keys(r.m).length;
      } catch (e) {}
    return n;
  }
  const startedAt = Date.now();
  let lastReport = '';
  function report(force) {
    const found = {};
    for (const k of NAMES) found[k] = !!mod[k];
    const msg = { t: 'modules', found, runtimes: requires.size, factories: moduleCount(), ran: records.length };
    const key = JSON.stringify(msg);
    if (key === lastReport && !force) return;
    lastReport = key;
    post(msg);
  }
  function resolveTick() {
    try {
      resolveExports();
      resolveStore();
    } catch (e) {}
    report(false);
    if (NAMES.every((k) => mod[k])) return;
    // Often while the app loads (its chunks come in the first seconds), then less, then rarely.
    const age = Date.now() - startedAt;
    setTimeout(resolveTick, age < 15_000 ? 250 : age < 120_000 ? 1000 : 10_000);
  }
  setTimeout(resolveTick, 250);

  // ------------------------------------------------------------ the app's keys, in the page
  const appApi = () => (mod.AppApi && isFn(mod.AppApi.api) ? mod.AppApi.api : null);
  function need(names) {
    const missing = names.filter((k) => !mod[k]);
    if (missing.length) throw Object.assign(new Error(`not found in the page: ${missing.join(', ')}`), { missing });
  }
  const str = (v) => typeof v === 'string';
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  /** The account's addresses as the app has them (its store), checked for the fields used here. */
  function addressesOf(state) {
    const a = state && state.addresses && state.addresses.value;
    if (!Array.isArray(a)) throw new Error("the page's store has no addresses yet");
    return a.filter((x) => isObj(x) && str(x.ID) && str(x.Email)).map((x) => ({ ID: x.ID, Email: x.Email, DisplayName: str(x.DisplayName) ? x.DisplayName : '', Status: num(x.Status) ? x.Status : 0, Send: num(x.Send) ? x.Send : 0, Receive: num(x.Receive) ? x.Receive : 0, Order: num(x.Order) ? x.Order : 0 }));
  }
  function checkKeys(k) {
    if (!isObj(k) || !Array.isArray(k.decryptionKeys) || !Array.isArray(k.signingKeys) || !isObj(k.encryptionKey)) throw new Error("the app's address keys did not come back as expected");
    return k;
  }
  const keysCache = new Map(); // address id -> the app's key references (handles into its crypto proxy, not keys)
  async function keysOf(addressID, fresh) {
    let k = fresh ? null : keysCache.get(addressID);
    if (!k) {
      need(['Store', 'AddressKeysByUsage']);
      k = checkKeys(await mod.Store.dispatch(mod.AddressKeysByUsage({ AddressID: addressID, withV6SupportForEncryption: true, withV6SupportForSigning: false })));
      keysCache.set(addressID, k);
    }
    return k;
  }
  /** Every address's keys, the named address's first (the crypto proxy picks the key a message names). */
  async function decryptionKeys(addressID) {
    const ids = addressesOf(mod.Store.getState()).map((a) => a.ID);
    if (addressID && !ids.includes(addressID)) ids.unshift(addressID);
    ids.sort((x, y) => (y === addressID) - (x === addressID));
    const all = [];
    for (const id of ids) {
      try {
        all.push(...(await keysOf(id)).decryptionKeys);
      } catch (e) {}
    }
    return all;
  }

  /** Counts of what the app's keys open with: the extractor's unlock through the page. */
  async function pageKeys() {
    need(['CryptoProxy', 'Store', 'AddressKeysByUsage']);
    keysCache.clear();
    const addresses = addressesOf(mod.Store.getState());
    let withKeys = 0;
    let keys = 0;
    for (const a of addresses) {
      try {
        const k = await keysOf(a.ID);
        if (k.decryptionKeys.length) withKeys++;
        keys += k.decryptionKeys.length;
      } catch (e) {}
    }
    if (!keys) throw new Error("the app's keys did not open for any address");
    return { addresses: addresses.length, withKeys, keys };
  }

  /** A body (armored) or an attachment (key packets and data packet), decrypted by the app's crypto proxy. */
  async function decrypt(c) {
    need(['CryptoProxy', 'Store', 'AddressKeysByUsage']);
    const CP = mod.CryptoProxy;
    const keys = await decryptionKeys(str(c.addressID) ? c.addressID : null);
    if (!keys.length) throw new Error('no key of the app opens for this');
    let r;
    if (str(c.armored)) r = await CP.decryptMessage({ armoredMessage: c.armored, decryptionKeys: keys, format: 'binary' });
    else if (str(c.keyPackets) && str(c.data)) {
      const sessionKey = await CP.decryptSessionKey({ binaryMessage: fromBase64(c.keyPackets), decryptionKeys: keys });
      if (!isObj(sessionKey) || !(sessionKey.data instanceof Uint8Array)) throw new Error('the session key did not open');
      r = await CP.decryptMessage({ binaryMessage: fromBase64(c.data), sessionKeys: [sessionKey], format: 'binary' });
    } else throw new Error('decrypt what?');
    if (!isObj(r) || !(r.data instanceof Uint8Array)) throw new Error('the crypto proxy answered something else');
    return { base64: toBase64(r.data) };
  }

  // ------------------------------------------------------------ sending: the safe subset of the composer's
  // Proton's numbers (WebClients packages/shared/lib/constants.ts, mail/mailSettings.ts, mail/constants.ts).
  const PACKAGE = { PM: 1, CLEAR: 4 }; // PACKAGE_TYPE.SEND_PM, SEND_CLEAR: the only two this sends
  const KEY_FLAG = { NOT_COMPROMISED: 1, NOT_OBSOLETE: 2, EMAIL_NO_ENCRYPT: 4 };
  const KEY_SOURCE_PROTON = 0; // API_KEY_SOURCE.PROTON; WKD 1, KOO 2
  const SIGNATURES_ATTACHMENTS = 1; // PACKAGE_SIGNATURES_MODE; SIGNATURES_NONE is 0
  const FLAG_RECEIVED = 1; // MESSAGE_FLAGS.FLAG_RECEIVED, which addReceived sets on every package
  const PGP_INLINE = 8; // MailSettings.PGPScheme for PGP/Inline
  const AES256 = 'aes256';
  /** vCard properties that carry a contact's encryption settings (packages/shared/lib/contacts/keyProperties.ts). */
  const CONTACT_PROPS = ['KEY', 'X-PM-ENCRYPT', 'X-PM-ENCRYPT-UNTRUSTED', 'X-PM-SIGN', 'X-PM-SCHEME', 'X-PM-MIMETYPE'];
  const CONTACT_CARD_CLEAR = 0;
  const CONTACT_CARD_SIGNED = 2;
  const ID_OK = /^[A-Za-z0-9_=+-]{1,200}$/;

  const redact = (m) => String(m).replace(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/g, '<address>');
  const refuse = (status, message, code) => ({ refused: { status, message: redact(message).slice(0, 1500), ...(code ? { code } : {}) } });
  const errText = (e) => {
    const d = e && e.data;
    if (isObj(d) && str(d.Error)) return `${d.Error}${num(d.Code) ? ` (code ${d.Code})` : ''}`;
    return String((e && e.message) || e).slice(0, 200);
  };
  const statusOf = (e) => (e && num(e.status) && e.status >= 400 ? e.status : 502);
  const recipient = (r) => ({ Name: str(r.name) ? r.name : '', Address: r.email });
  const short = (t) => redact(t).replace(/\s+/g, ' ').trim().slice(0, 120);

  /** canonicalizeEmail(email, CANONICALIZE_SCHEME.PROTON) (helpers/email.ts): no +alias, no . _ -, lower case. */
  function canonicalInternal(email) {
    const at = email.lastIndexOf('@');
    const local = at < 0 ? email : email.slice(0, at);
    const domain = at < 0 ? '' : email.slice(at + 1);
    return `${local.split('+')[0].replace(/[._-]/g, '').toLowerCase()}${at < 0 ? '' : '@'}${domain.toLowerCase()}`;
  }
  const hasBit = (flags, bit) => num(flags) && (flags & bit) === bit;

  /** Whether the crypto proxy says a key can encrypt now (getKeyEncryptionCapableStatus). Unknown is no. */
  async function canEncrypt(CP, key) {
    if (!isFn(CP.canKeyEncrypt)) throw new Error('this page cannot check keys');
    try {
      return (await CP.canKeyEncrypt({ key, date: new Date() })) === true;
    } catch (e) {
      return false;
    }
  }

  /** A vCard has one of the encryption properties, under any group (`item1.KEY;PREF=1:…`, `X-PM-ENCRYPT:true`). */
  function hasEncryptionProps(vcard) {
    for (const line of vcard.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Za-z0-9-]+\.)?([A-Za-z0-9-]+)[;:]/);
      if (m && CONTACT_PROPS.includes(m[1].toUpperCase())) return true;
    }
    return false;
  }

  /**
   * The recipient in your Proton contacts (packages/shared/lib/api/helpers/getPublicKeysVcardHelper.ts): the store's
   * contact emails and the API's (contacts/v4/contacts/emails?Email=…), every match. A contact email Proton marks as
   * having settings of its own (Defaults not 1), or a contact whose clear or signed card names any encryption property,
   * is refused; so is one whose cards cannot be read. Proton reads only the signed card of the first match; this reads
   * every match's clear and signed cards, to be safe.
   */
  async function contactProblem(call, state, lower) {
    const found = [];
    const add = (ce) => isObj(ce) && found.push(ce);
    const map = isObj(state.mailContacts) && isObj(state.mailContacts.contactsMap) ? state.mailContacts.contactsMap : null;
    if (map && map[lower]) add(map[lower]);
    const list = isObj(state.contactEmails) && Array.isArray(state.contactEmails.value) ? state.contactEmails.value : [];
    for (const ce of list) if (isObj(ce) && str(ce.Email) && ce.Email.toLowerCase() === lower) add(ce);
    let r;
    try {
      r = await call({ method: 'get', url: 'contacts/v4/contacts/emails', params: { Email: lower }, silence: true });
    } catch (e) {
      return { kind: 'confirm', reason: `your contacts could not be searched: ${short(errText(e))}` };
    }
    if (!isObj(r) || (r.ContactEmails !== undefined && !Array.isArray(r.ContactEmails))) return { kind: 'confirm', reason: 'your contacts answered in a shape this does not know' };
    for (const ce of r.ContactEmails || []) add(ce);
    if (!found.length) return null;
    const ids = [];
    for (const ce of found) {
      if (ce.Defaults !== 1) return { kind: 'contacts' };
      if (!str(ce.ContactID) || !ID_OK.test(ce.ContactID)) return { kind: 'confirm', reason: 'their contact card could not be read' };
      if (!ids.includes(ce.ContactID)) ids.push(ce.ContactID);
    }
    for (const id of ids) {
      let c;
      try {
        c = await call({ method: 'get', url: `contacts/v4/contacts/${id}`, silence: true });
      } catch (e) {
        return { kind: 'confirm', reason: 'their contact card could not be read' };
      }
      const cards = isObj(c) && isObj(c.Contact) && Array.isArray(c.Contact.Cards) ? c.Contact.Cards : null;
      if (!cards) return { kind: 'confirm', reason: 'their contact card could not be read' };
      for (const card of cards) {
        if (!isObj(card) || !num(card.Type)) return { kind: 'confirm', reason: 'their contact card could not be read' };
        if (card.Type !== CONTACT_CARD_CLEAR && card.Type !== CONTACT_CARD_SIGNED) continue;
        if (!str(card.Data)) return { kind: 'confirm', reason: 'their contact card could not be read' };
        if (hasEncryptionProps(card.Data)) return { kind: 'contacts' };
      }
    }
    return null;
  }

  /**
   * Sending to one of your own addresses (getEncryptionPreferences' selfSend): Proton uses that address's own primary
   * key for encryption, as the app's keys by usage pick it, and asks the API nothing. It must be able to encrypt and
   * not be obsolete.
   */
  async function selfDecision(CP, raw, id) {
    if (num(raw.HasKeys) && !raw.HasKeys) return { kind: 'nokey' };
    let keys;
    try {
      keys = await keysOf(id, true);
    } catch (e) {
      return { kind: 'nokey' };
    }
    const key = keys.encryptionKey;
    if (Array.isArray(raw.Keys)) {
      const fp = isFn(key.getFingerprint) ? String(key.getFingerprint()).toLowerCase() : null;
      const primaries = raw.Keys.filter((k) => isObj(k) && k.Primary === 1);
      const k = raw.Keys.find((x) => isObj(x) && fp && str(x.Fingerprint) && x.Fingerprint.toLowerCase() === fp) || (primaries.length === 1 ? primaries[0] : null);
      if (k && num(k.Flags) && !hasBit(k.Flags, KEY_FLAG.NOT_OBSOLETE)) return { kind: 'nokey' };
    }
    if (!(await canEncrypt(CP, key))) return { kind: 'nokey' };
    return { kind: 'pm', key };
  }

  /**
   * Someone else: core/v4/keys/all as Proton's getAllPublicKeys asks it (packages/key-transparency/lib/keys/
   * getAndVerifyApiKeys.ts, getPublicKeysEmailHelperWithKT.ts), read conservatively. A Proton address (keys in
   * Address.Keys, RecipientType 1) gets its key as Proton picks it (keys/publicKeys.ts sortApiKeys with v6 preferred, as
   * for mail; then extractEncryptionPreferencesInternal: the first must be fit to send to). An outside address with no
   * key anywhere (RecipientType 2) goes in the clear. Anything else is refused: an error, warnings, only unverified or
   * catch-all keys (looked at only when Address.Keys is empty, as Proton does), an outside address with keys, a Proton
   * address with none it can encrypt to.
   */
  async function apiDecision(call, CP, lower) {
    let res;
    try {
      res = await call({ method: 'get', url: 'core/v4/keys/all', params: { Email: lower, InternalOnly: 0 }, silence: true });
    } catch (e) {
      return { kind: 'confirm', reason: `its key lookup failed: ${short(errText(e))}` };
    }
    const shape = { kind: 'confirm', reason: 'its key lookup answered in a shape this does not know' };
    if (!isObj(res)) return shape;
    if (res.Warnings !== undefined && res.Warnings !== null && !Array.isArray(res.Warnings)) return shape;
    const warnings = (res.Warnings || []).map((w) => String(w)).filter(Boolean);
    if (warnings.length) return { kind: 'confirm', reason: `Proton warns: ${short(warnings.join('; '))}` };
    const keysIn = (x) => (x === undefined || x === null ? [] : isObj(x) && Array.isArray(x.Keys) && x.Keys.every((k) => isObj(k) && str(k.PublicKey) && num(k.Flags)) ? x.Keys : null);
    const address = keysIn(res.Address);
    const unverified = keysIn(res.Unverified);
    const catchAll = keysIn(res.CatchAll);
    if (!address || !unverified || !catchAll) return shape;
    // Proton's current client infers the kind from Address.Keys and does not read RecipientType; when it is there, it
    // must agree.
    const type = res.RecipientType === undefined || res.RecipientType === null ? undefined : res.RecipientType;
    if (type !== undefined && type !== 1 && type !== 2) return shape;
    // As getPublicKeysEmailHelperWithKT reads it: verified Address.Keys, when there are any, decide alone (unverified and
    // catch-all keys are looked at only without them), so a Proton address that also has unverified keys is still sent to.
    if (!address.length) {
      if (unverified.length) {
        if (type !== 1 && unverified.every((k) => k.Source !== KEY_SOURCE_PROTON)) return { kind: 'published' };
        return { kind: 'confirm', reason: 'Proton has only unverified keys for it' };
      }
      if (catchAll.length) return { kind: 'confirm', reason: 'it is a catch-all address' };
      return type === 1 ? { kind: 'nokey' } : { kind: 'clear' };
    }
    if (type === 2) return { kind: 'published' };
    // A Proton address: its keys meant for mail (getMailCapableKeys), imported as the app imports them.
    const keys = [];
    for (const k of address) {
      if (hasBit(k.Flags, KEY_FLAG.EMAIL_NO_ENCRYPT)) continue;
      let ref = null;
      try {
        ref = await CP.importPublicKey({ armoredKey: k.PublicKey });
      } catch (e) {}
      if (ref) keys.push({ ref, flags: k.Flags, primary: k.Primary === 1 });
    }
    if (!keys.length) return { kind: 'nokey' };
    if (!keys.every((k) => isFn(k.ref.getVersion))) return { kind: 'confirm', reason: 'this page cannot check keys' };
    // sortApiKeys: by a bitmap of (least to most weighty) not v6, not primary, obsolete, compromised; none are trusted.
    const rank = (k) => (k.ref.getVersion() !== 6 ? 1 : 0) + (k.primary ? 0 : 2) + (hasBit(k.flags, KEY_FLAG.NOT_OBSOLETE) ? 0 : 4) + (hasBit(k.flags, KEY_FLAG.NOT_COMPROMISED) ? 0 : 8);
    const sorted = keys.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i);
    const first = sorted[0].k;
    if (!hasBit(first.flags, KEY_FLAG.NOT_OBSOLETE) || !hasBit(first.flags, KEY_FLAG.NOT_COMPROMISED) || !(await canEncrypt(CP, first.ref))) return { kind: 'nokey' };
    return { kind: 'pm', key: first.ref };
  }

  /** "1", "1 and 3", "1, 2 and 3". */
  const numbers = (ns) => (ns.length === 1 ? String(ns[0]) : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);
  /** One sentence per kind of problem (and per reason), in recipient order, for a person to read. */
  function problemSentences(problems) {
    const groups = new Map();
    for (const p of problems) {
      const k = `${p.kind}\n${p.reason || ''}`;
      if (!groups.has(k)) groups.set(k, { kind: p.kind, reason: p.reason, ns: [] });
      groups.get(k).ns.push(p.n);
    }
    const out = [];
    for (const { kind, reason, ns } of groups.values()) {
      const one = ns.length === 1;
      const Who = `${one ? 'Recipient' : 'Recipients'} ${numbers(ns)}`;
      const who = `${one ? 'recipient' : 'recipients'} ${numbers(ns)}`;
      if (kind === 'contacts') out.push(`${Who} ${one ? 'has' : 'have'} encryption settings or a pinned key in your Proton contacts, so send this one from Proton.`);
      else if (kind === 'published') out.push(`${Who} ${one ? 'publishes an encryption key' : 'publish encryption keys'}, so Proton would encrypt to ${one ? 'it' : 'them'}; send this one from Proton.`);
      else if (kind === 'confirm') out.push(`Proton couldn't confirm how to send to ${who} (${reason}), so send this one from Proton.`);
      else out.push(`Proton gave no key it can encrypt to for ${who}, so send this one from Proton.`);
    }
    return out.join(' ');
  }
  // Only the code matters here: the extractor puts the sentence for a person on it (send.ts SETTINGS_REFUSAL), so nothing
  // in the page names the app.
  const SETTINGS_REFUSAL = 'the mail settings sign outside mail or attach the public key';

  /** The mail settings: the store's (what the composer uses) and the server's now; either one's word counts. */
  async function mailSettingsOf(call, state) {
    const stored = isObj(state.mailSettings) && isObj(state.mailSettings.value) ? state.mailSettings.value : null;
    let fresh = null;
    try {
      const r = await call({ method: 'get', url: 'mail/v4/settings', silence: true });
      fresh = isObj(r) && isObj(r.MailSettings) ? r.MailSettings : null;
    } catch (e) {}
    const all = [stored, fresh].filter(Boolean);
    if (!all.length || !all.every((m) => num(m.Sign) && num(m.AttachPublicKey))) return null;
    const pick = (k) => (stored && num(stored[k]) ? stored[k] : fresh && num(fresh[k]) ? fresh[k] : undefined);
    return {
      sign: all.some((m) => m.Sign === 1),
      attachPublicKey: all.some((m) => m.AttachPublicKey === 1),
      inline: all.some((m) => m.PGPScheme === PGP_INLINE),
      autoSaveContacts: pick('AutoSaveContacts'),
      delaySendSeconds: pick('DelaySendSeconds'),
    };
  }

  /** sendFormatter's serializeJsonToFormData: nested keys in brackets, bytes as a Blob. */
  function formOf(out, at, v) {
    if (v instanceof Uint8Array) out[at] = new Blob([v]);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) formOf(out, `${at}[${k}]`, x);
    else out[at] = v;
  }

  /**
   * One message, the safe subset of what Proton's composer sends (useSendVerifications, useSendMessage). First, before
   * anything is made on the server, each recipient (to, cc, bcc; each address once, numbered in that order): your own
   * address, a Proton user, or an outside address with no key, else refused (contactProblem, selfDecision,
   * apiDecision); then your mail settings, which must not ask to sign or attach your key for an outside address. Then
   * the draft and the attachments, encrypted to your address key; then the packages as Proton builds them for package
   * types 1 (SEND_PM) and 4 (SEND_CLEAR) (sendTopPackages, sendSubPackages, sendEncrypt), checked against the decisions;
   * then the form (sendFormatter) through the app's API caller.
   */
  async function send(c) {
    const missing = NAMES.filter((k) => !mod[k]);
    if (missing.length) return refuse(501, `the Mail page's ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not found, so nothing was sent`);
    const store = mod.Store;
    const call = appApi();
    const CP = mod.CryptoProxy;
    if (!call) return refuse(503, "the app's API caller is not ready");
    const state = store.getState();
    let addresses;
    try {
      addresses = addressesOf(state);
    } catch (e) {
      return refuse(503, e.message);
    }
    const senders = addresses.filter((a) => a.Status === 1 && a.Send === 1).sort((a, b) => a.Order - b.Order);
    // An address the app chose (`from`) is the one, or nothing is sent; otherwise the original's (a reply), else the first.
    const chosen = str(c.fromAddressID) ? senders.find((a) => a.ID === c.fromAddressID) : null;
    if (str(c.fromAddressID) && !chosen) return refuse(422, 'from is not one of the addresses this account can send from (in the page)', 'from');
    const from = chosen || (str(c.addressID) && senders.find((a) => a.ID === c.addressID)) || senders[0];
    if (!from) return refuse(422, 'this account has no address it can send from', 'from');

    const to = (c.to || []).map(recipient);
    const cc = (c.cc || []).map(recipient);
    const bcc = (c.bcc || []).map(recipient);
    const emails = [...new Set([...to, ...cc, ...bcc].map((r) => r.Address))];
    if (!emails.length) return refuse(400, 'to whom?');
    const html = str(c.html);
    const MIMEType = html ? 'text/html' : 'text/plain';
    const body = html ? c.html : String(c.text || '');

    // 1. Each recipient, before anything is made on the server.
    const rawAddresses = (Array.isArray(state.addresses.value) ? state.addresses.value : []).filter((a) => isObj(a) && str(a.ID) && str(a.Email));
    const decisions = new Map();
    const problems = [];
    let n = 0;
    for (const email of emails) {
      n++;
      const lower = email.toLowerCase();
      let d;
      try {
        // getSelfSendAddresses: your addresses that receive; matched as Proton matches its own addresses.
        const self = rawAddresses.find((a) => a.Receive && canonicalInternal(a.Email) === canonicalInternal(email));
        if (self) d = await selfDecision(CP, self, self.ID);
        else d = (await contactProblem(call, state, lower)) || (await apiDecision(call, CP, lower));
      } catch (e) {
        d = { kind: 'confirm', reason: short(errText(e)) };
      }
      if (d.kind === 'pm' || d.kind === 'clear') decisions.set(email, d);
      else problems.push({ n, ...d });
    }
    if (problems.length) return refuse(422, problemSentences(problems), 'recipients');
    const clearCount = emails.filter((e) => decisions.get(e).kind === 'clear').length;

    // Your settings: Proton would sign mail to an outside address (Sign, getSendPreferences), or attach your public key
    // (AttachPublicKey), or send everyone plain text for an HTML message (Sign with PGP/Inline: extractDraftMIMEType).
    const settings = await mailSettingsOf(call, state);
    if (!settings) return refuse(503, 'your Proton mail settings could not be read, so nothing was sent');
    if ((clearCount && (settings.sign || settings.attachPublicKey)) || (html && settings.sign && settings.inline)) return refuse(422, SETTINGS_REFUSAL, 'settings');

    // 2. The draft (its body encrypted to your address key and signed with it), then the attachments.
    let messageKeys;
    try {
      // Asked afresh, as the composer asks for them when it sends.
      messageKeys = await keysOf(from.ID, true);
    } catch (e) {
      return refuse(503, `your address keys did not open in the page: ${errText(e)}`);
    }
    const data = { ToList: to, CCList: cc, BCCList: bcc, Subject: String(c.subject || ''), PasswordHint: '', Attachments: [], MIMEType, Flags: 0, Sender: { Name: from.DisplayName, Address: from.Email }, AddressID: from.ID, Unread: 0 };
    let draft;
    try {
      const { message: Body } = await CP.encryptMessage({ textData: body, stripTrailingSpaces: true, encryptionKeys: messageKeys.encryptionKey, signingKeys: messageKeys.signingKeys });
      const r = await call({ method: 'post', url: 'mail/v4/messages', data: { Message: { ...data, Body }, ...(str(c.parentID) ? { ParentID: c.parentID, Action: 0 } : {}) } });
      draft = r && r.Message;
      if (!isObj(draft) || !str(draft.ID) || !ID_OK.test(draft.ID)) throw new Error('Proton made no draft');
    } catch (e) {
      return refuse(statusOf(e), `Proton would not make the draft: ${errText(e)}`);
    }
    const cleanup = async () => {
      try {
        await call({ method: 'put', url: 'mail/v4/messages/delete', data: { IDs: [draft.ID] } });
      } catch (e) {}
    };
    /** Each attachment as Proton keeps it, with the session key it was encrypted under here. */
    const uploaded = [];
    try {
      for (const a of c.attachments || []) {
        const bytes = fromBase64(a.base64);
        const sessionKey = await CP.generateSessionKey({ recipientKeys: messageKeys.encryptionKey });
        const enc = await CP.encryptMessage({ format: 'binary', detached: true, binaryData: bytes, sessionKey, signingKeys: messageKeys.signingKeys });
        const keyPackets = await CP.encryptSessionKey({ ...sessionKey, encryptionKeys: messageKeys.encryptionKey, format: 'binary' });
        const r = await call({
          method: 'post',
          url: 'mail/v4/attachments',
          input: 'form',
          data: { Filename: a.filename, MessageID: draft.ID, MIMEType: a.mime, KeyPackets: new Blob([keyPackets]), DataPacket: new Blob([enc.message]), ...(enc.signature ? { Signature: new Blob([enc.signature]) } : {}) },
        });
        const att = r && r.Attachment;
        if (!isObj(att) || !str(att.ID) || !str(att.KeyPackets)) throw new Error('Proton kept no attachment');
        uploaded.push({ att, sessionKey });
      }
    } catch (e) {
      await cleanup();
      return refuse(statusOf(e), `Proton would not take an attachment: ${errText(e)}`);
    }

    // 3. The packages: one, for the message's own MIME type, with every recipient in it (sendTopPackages: the type a
    // recipient wants is the message's when no contact or setting says otherwise; sendSubPackages: SEND_PM with the
    // signature flag when every attachment is signed, SEND_CLEAR without; the package's Type is their OR).
    let packages;
    let payload;
    try {
      const pkg = { Flags: (num(draft.Flags) ? draft.Flags : 0) | FLAG_RECEIVED, Addresses: {}, MIMEType, Body: body, Type: 0 };
      const signed = uploaded.every(({ att }) => !!att.Signature);
      for (const email of emails) {
        const entry = decisions.get(email).kind === 'pm' ? { Type: PACKAGE.PM, Signature: signed ? SIGNATURES_ATTACHMENTS : 0 } : { Type: PACKAGE.CLEAR, Signature: 0 };
        pkg.Addresses[email] = entry;
        pkg.Type |= entry.Type;
      }
      // sendEncrypt's encryptDraftBodyPackage (the package's MIME type is the draft's): one session key good for your key
      // and theirs, the body encrypted under it and signed with your address keys, the key given to each Proton
      // recipient's key, and in the clear to the package when anyone gets it in the clear.
      const theirs = emails.filter((e) => decisions.get(e).kind === 'pm');
      const sessionKey = await CP.generateSessionKey({ recipientKeys: [messageKeys.encryptionKey, ...theirs.map((e) => decisions.get(e).key)] });
      const { message: encrypted } = await CP.encryptMessage({ textData: body, sessionKey, signingKeys: messageKeys.signingKeys, format: 'binary' });
      if (!(encrypted instanceof Uint8Array)) throw new Error('the crypto proxy gave no encrypted body');
      for (const email of theirs) {
        const key = decisions.get(email).key;
        const entry = pkg.Addresses[email];
        entry.BodyKeyPacket = toBase64(await CP.encryptSessionKey({ ...sessionKey, encryptionKeys: key, format: 'binary' }));
        // encryptAttachmentKeys: each attachment's session key, to their key.
        if (uploaded.length) {
          entry.AttachmentKeyPackets = {};
          for (const { att, sessionKey: sk } of uploaded) entry.AttachmentKeyPackets[att.ID] = toBase64(await CP.encryptSessionKey({ data: sk.data, algorithm: sk.algorithm, encryptionKeys: [key], format: 'binary' }));
        }
      }
      if (pkg.Type & PACKAGE.CLEAR) {
        pkg.BodyKey = { Key: toBase64(sessionKey.data), Algorithm: sessionKey.algorithm || AES256 };
        if (uploaded.length) {
          pkg.AttachmentKeys = {};
          for (const { att, sessionKey: sk } of uploaded) pkg.AttachmentKeys[att.ID] = { Key: toBase64(sk.data), Algorithm: sk.algorithm || AES256 };
        }
      }
      pkg.Body = encrypted;
      packages = { [MIMEType]: pkg };
      checkPackages(packages, decisions, emails, uploaded.map(({ att }) => att.ID));
      // sendFormatter: Packages[…] as a form; no ExpiresIn; DelaySeconds and AutoSaveContacts from your settings.
      const form = {};
      formOf(form, 'Packages', packages);
      if (settings.delaySendSeconds) form.DelaySeconds = settings.delaySendSeconds;
      if (settings.autoSaveContacts !== undefined) form.AutoSaveContacts = settings.autoSaveContacts;
      payload = { method: 'post', url: `mail/v4/messages/${draft.ID}`, input: 'form', data: form };
    } catch (e) {
      await cleanup();
      return refuse(500, `the packages did not come out right, so nothing was sent: ${errText(e)}`);
    }

    // 4. Send, through the app's own API caller.
    let sent;
    try {
      const r = await call({ ...payload, timeout: 60000 });
      sent = r && r.Sent;
      if (!isObj(sent) || !str(sent.ID)) throw new Error('Proton said nothing about the sent message');
    } catch (e) {
      await cleanup();
      return refuse(statusOf(e), `Proton did not send it: ${errText(e)}`);
    }
    const encryptedTo = emails.length - clearCount;
    log('info', `send: ${emails.length} recipient(s), ${encryptedTo} encrypted, ${clearCount} in the clear, ${uploaded.length} attachment(s), package ${MIMEType}:${packages[MIMEType].Type}`);
    return { sent: { id: sent.ID, externalId: str(sent.ExternalID) ? sent.ExternalID : null, recipients: emails.length, encrypted: encryptedTo } };
  }

  /**
   * The packages say what the decisions said: one package, every recipient in it once; one encrypted to has type 1, a
   * body key packet, and an attachment key packet for each attachment; one in the clear has type 4 and no key packet;
   * the package's type is their OR, and it carries the session keys in the clear exactly when someone gets it in the
   * clear. Anything else is refused.
   */
  function checkPackages(packages, decisions, emails, attachmentIds) {
    const list = Object.entries(packages);
    if (list.length !== 1) throw new Error('not one package');
    const [mime, p] = list[0];
    if ((mime !== 'text/html' && mime !== 'text/plain') || p.MIMEType !== mime || !isObj(p.Addresses) || !num(p.Type) || !(p.Body instanceof Uint8Array)) throw new Error('the package is not as expected');
    const names = Object.keys(p.Addresses);
    if (names.length !== emails.length || !emails.every((e) => names.includes(e))) throw new Error('a recipient is missing from the package, or one is there not asked for');
    let type = 0;
    for (const email of emails) {
      const sub = p.Addresses[email];
      const d = decisions.get(email);
      if (!isObj(sub) || !num(sub.Type)) throw new Error('a recipient entry is not as expected');
      type |= sub.Type;
      if (d.kind === 'pm') {
        if (sub.Type !== PACKAGE.PM || !str(sub.BodyKeyPacket) || !sub.BodyKeyPacket) throw new Error('a Proton recipient would not get it encrypted');
        const akp = sub.AttachmentKeyPackets || {};
        if (Object.keys(akp).length !== attachmentIds.length || !attachmentIds.every((id) => str(akp[id]) && akp[id])) throw new Error("a Proton recipient's attachments would not be encrypted to them");
      } else if (sub.Type !== PACKAGE.CLEAR || sub.BodyKeyPacket !== undefined || sub.AttachmentKeyPackets !== undefined) throw new Error('a recipient to send in the clear has a key packet');
    }
    if (type !== p.Type) throw new Error("the package's type is not its recipients'");
    const clear = (p.Type & PACKAGE.CLEAR) !== 0;
    if (clear !== isObj(p.BodyKey) || (clear && (!str(p.BodyKey.Key) || !str(p.BodyKey.Algorithm)))) throw new Error('the clear body key is wrong');
    const ak = p.AttachmentKeys;
    if (clear && attachmentIds.length ? !isObj(ak) || Object.keys(ak).length !== attachmentIds.length || !attachmentIds.every((id) => isObj(ak[id])) : ak !== undefined) throw new Error('the clear attachment keys are wrong');
  }

  // ------------------------------------------------------------ the pipe
  cloak.onDown(async (p) => {
    if (p.t === 'settings') {
      // The pipe is up (again): say everything once more, in case the first words were lost.
      post({ t: 'hook', page: location.origin + location.pathname });
      session(true);
      report(true);
      return;
    }
    if (p.t !== 'cmd' || !p.cmd) return;
    try {
      let result;
      const k = p.cmd.kind;
      if (k === 'api') result = await api(p.cmd);
      else if (k === 'storage') result = storage();
      else if (k === 'pagekeys') result = await pageKeys();
      else if (k === 'decrypt') result = await decrypt(p.cmd);
      else if (k === 'send') result = await send(p.cmd);
      else throw new Error(`no command ${k}`);
      post({ t: 'reply', id: p.id, ok: true, result });
    } catch (err) {
      post({ t: 'reply', id: p.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  });

  post({ t: 'hook', page: location.origin + location.pathname });
  session(false);
  setInterval(() => session(false), 2000);
  // The app changes pages without loading (history.pushState): say so when the path changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      session(false);
    }
  }, 500);
  log('debug', 'hook loaded');
})();
