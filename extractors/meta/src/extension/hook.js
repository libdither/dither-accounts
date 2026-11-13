/*
 * MAIN-world content script on messenger.com, facebook.com and instagram.com, injected at document_start.
 *
 * Meta's web apps are not webpack: they ship Haste modules, each defined through `__d(name, deps, factory)` and
 * required by a stable string name. This hook reaches the client's own modules by those names (or, failing that, by
 * their shape), the way the Discord hook reaches webpack's modules:
 *
 *   - the module system: `require("__debug").modulesMap` (every module record, its exports once its factory ran),
 *     `ifRequired` (exports of a module that already ran, never running one), a trap on `__d` (every module's name as
 *     it is defined) and `__onAfterModuleFactory` (each module as its factory finishes);
 *   - where the client itself sees plaintext: Messenger's LightSpeed database (ReStore: the tables the inbox renders
 *     from, decrypted end-to-end chats included, which the client mirrors into them), Instagram's Relay store (the
 *     "Slide" mailbox: threads, messages and users as records);
 *   - commands through the client's own code paths: Instagram's message API modules (IGDMAPI*), its Relay mutations;
 *     Messenger's own task queue (only with task shapes the client itself was seen using), or its composer.
 *
 * Every hook point has fallbacks, and a self-test reports which were found (names and found/missing only). What it
 * forwards is whitelisted and checked against the fields it needs; what does not match is dropped and counted. It
 * never fetches anything itself except an attachment the page already holds (a blob: URL); everything else is the
 * client's own requests, made because the client was asked to do what a person would. It never sees the bridge token:
 * it talks to content.js over the channel in main-world.js (put in below when the extension is copied), which also
 * keeps its traps and wrappers looking like what they stand in for. Plain JS on purpose (no build step), and every
 * global it touches is named, so tests can run it with stand-ins.
 */
(() => {
  'use strict';
  // Sign-in, checkpoint and consent pages run nothing of ours, not even the traps, nor what every hook shares.
  const AUTH_PATH = /^\/(login|checkpoint|recover|two_step_verification|two_factor|challenge|auth_platform|confirmemail|privacy\/consent|cookie\/consent|accounts\/(login|onetap|emailsignup|password|two_factor|suspended|disabled))/i;
  if (AUTH_PATH.test(location.pathname)) return;

  // ------------------------------------------------------------------ bridge
  /*@include main-world@*/
  const W = window;
  if (!cloak.once()) return;
  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg: String(msg).slice(0, 300) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) =>
    Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
  const errText = (e) => String((e && e.message) || e).slice(0, 200);

  // ------------------------------------------------------------- the values
  // LightSpeed keeps 64-bit integers as [high, low] pairs; Relay keeps ids as strings, timestamps as strings or numbers.
  const isI64 = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
  function i64str(v) {
    try {
      return ((BigInt(v[0]) << 32n) + BigInt(v[1] >>> 0)).toString();
    } catch (e) {
      return null;
    }
  }
  function idOf(v) {
    if (typeof v === 'string') return v.length && v.length < 200 ? v : null;
    if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : null;
    if (typeof v === 'bigint') return v.toString();
    if (isI64(v)) return i64str(v);
    if (v && typeof v === 'object' && I64mod) {
      try {
        const s = I64mod.to_string(v);
        return typeof s === 'string' ? s : null;
      } catch (e) {}
    }
    return null;
  }
  function numOf(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = idOf(v);
    if (s === null || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const strOf = (v) => (typeof v === 'string' ? v : null);
  const boolOf = (v) => (typeof v === 'boolean' ? v : v === 1 || v === 0 ? !!v : null);
  /** LightSpeed keeps lists (mention offsets) as comma-separated strings, or arrays. */
  function listOf(v) {
    if (Array.isArray(v)) return v.map(idOf).filter((x) => x !== null);
    if (typeof v === 'string') return v.length ? v.split(',').map((x) => x.trim()) : [];
    return null;
  }
  const CONVERT = { id: idOf, n: numOf, s: strOf, b: boolOf, l: listOf };

  // Objects that do not have what we need are dropped here and counted (by type), never forwarded half-made.
  const dropped = {};
  function drop(type) {
    dropped[type] = (dropped[type] || 0) + 1;
    return null;
  }
  /** Copy the whitelisted fields, converted; null (and counted) if a required one is missing. */
  function pick(type, src, spec) {
    if (!src || typeof src !== 'object') return drop(type);
    const out = {};
    for (const k in spec.cols) {
      let v = null;
      try {
        v = CONVERT[spec.cols[k]](src[k]);
      } catch (e) {
        v = null;
      }
      if (v !== null && v !== undefined) out[k] = v;
    }
    for (const k of spec.req) if (out[k] === undefined) return drop(type);
    return out;
  }

  // ------------------------------------------------------------------- Haste
  // Three independent ways to the modules, so losing one leaves the others: the module system's own record map
  // (`__debug.modulesMap`), its `ifRequired`, and our trap on `__d` (names only, as modules are defined).
  const H = (() => {
    const names = new Set();
    const watchers = new Map(); // module name -> [fn(exports)]
    const wrapped = new WeakSet();
    let debugMap = null;
    let theirAfter = null;
    let realRequire = null;
    const via = { names: 'none', records: 'none' };

    function noteName(name) {
      if (typeof name === 'string' && name.length < 300) names.add(name);
    }
    function wrapD(fn) {
      if (typeof fn !== 'function' || wrapped.has(fn)) return fn;
      const w = cloak.wrap(fn, (self, args) => {
        try {
          noteName(args[0]);
        } catch (e) {}
        return cloak.apply(fn, self, args);
      });
      wrapped.add(w);
      return w;
    }
    const afterFactory = {
      onAfterModuleFactory(record) {
        return after(record);
      },
    }.onAfterModuleFactory;
    /** What reading __onAfterModuleFactory gives reads like theirs, or like a bound function when they set none. */
    function showAfter() {
      if (typeof theirAfter === 'function') cloak.native(afterFactory, theirAfter);
      else cloak.showAs(cloak.native(afterFactory, '', 1), 'function () { [native code] }');
    }
    function after(record) {
      try {
        if (theirAfter) theirAfter(record);
      } finally {
        try {
          const id = record && record.id;
          if (typeof id === 'string') {
            noteName(id);
            const list = watchers.get(id);
            if (list && record.factoryFinished && !record.hasError) {
              watchers.delete(id);
              for (const f of list) {
                try {
                  f(record.exports);
                } catch (e) {}
              }
            }
          }
        } catch (e) {}
      }
    }
    function install() {
      try {
        for (const e of W.__d_stub || []) noteName(e && e[0]);
      } catch (e) {}
      let cur = wrapD(W.__d);
      try {
        cloak.accessor(
          W,
          '__d',
          () => cur,
          (v) => {
            cur = wrapD(v);
            if (typeof W.require === 'function') realRequire = W.require;
          },
          true,
        );
        via.names = '__d';
      } catch (e) {
        log('warn', 'could not trap __d');
      }
      // The module system sets this to null when it starts, then calls it after every factory: chain it, keep theirs.
      try {
        theirAfter = typeof W.__onAfterModuleFactory === 'function' ? W.__onAfterModuleFactory : null;
        showAfter();
        cloak.accessor(
          W,
          '__onAfterModuleFactory',
          () => afterFactory,
          (v) => {
            theirAfter = typeof v === 'function' && v !== afterFactory ? v : null;
            showAfter();
          },
          true,
        );
      } catch (e) {}
    }
    function req() {
      return typeof W.require === 'function' ? W.require : realRequire;
    }
    function modulesMap() {
      if (debugMap) return debugMap;
      const r = req();
      if (!r) return null;
      try {
        const d = r('__debug');
        if (d && d.modulesMap && typeof d.modulesMap === 'object') {
          debugMap = d.modulesMap;
          via.records = '__debug.modulesMap';
        }
      } catch (e) {}
      return debugMap;
    }
    function ready() {
      return !!(modulesMap() || req());
    }
    /** A module's exports once its factory has run; never runs one unless `init` (what the client would do itself). */
    function get(name, init) {
      const map = modulesMap();
      if (map) {
        const rec = map[name];
        if (rec && rec.factoryFinished && !rec.hasError) return rec.exports;
        if (!rec || !init) return undefined;
      } else {
        const r = req();
        if (!r) return undefined;
        let out;
        try {
          r('ifRequired')(name, (e) => (out = e), () => {});
          if (via.records === 'none') via.records = 'ifRequired';
        } catch (e) {}
        if (out !== undefined || !init) return out;
      }
      try {
        return req()(name);
      } catch (e) {
        return undefined;
      }
    }
    function allNames() {
      const out = new Set(names);
      const map = modulesMap();
      if (map) for (const k in map) out.add(k);
      return out;
    }
    function count() {
      const map = modulesMap();
      let n = 0;
      if (map) for (const k in map) if (map[k] && map[k].factoryFinished) n++;
      return { defined: allNames().size, ran: n };
    }
    /** The exports, and the exports' own functions and objects, of every module that ran, filtered by name. */
    function* candidates(nameRe) {
      const map = modulesMap();
      for (const name of allNames()) {
        if (nameRe && !nameRe.test(name)) continue;
        if (name.endsWith('.graphql') || name.endsWith('$Parameters') || name.endsWith('RelayOperation')) continue;
        let exp;
        if (map) {
          const rec = map[name];
          if (!rec || !rec.factoryFinished || rec.hasError) continue;
          exp = rec.exports;
        } else exp = get(name);
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
        yield { name, key: null, value: exp };
        let keys = [];
        try {
          keys = Object.keys(exp);
        } catch (e) {}
        if (keys.length > 64) continue;
        for (const k of keys) {
          let v;
          try {
            v = exp[k];
          } catch (e) {
            continue;
          }
          if (v && (typeof v === 'object' || typeof v === 'function')) yield { name, key: k, value: v };
        }
      }
    }
    function find(test, nameRe) {
      for (const c of candidates(nameRe)) {
        let hit = false;
        try {
          hit = test(c.value);
        } catch (e) {}
        if (hit) return c;
      }
      return null;
    }
    /** Run fn(exports) once the module's factory has finished (now, or when it does). */
    function whenReady(name, fn) {
      const exp = get(name);
      if (exp !== undefined) return void fn(exp);
      const list = watchers.get(name) || [];
      list.push(fn);
      watchers.set(name, list);
    }
    /**
     * Wrap one export of a module the client calls by name at use time (`r("X")`, `o("X").f`): every caller gets the
     * wrapper. The wrapper must call the original and return what it returns.
     */
    function wrapExport(name, key, make) {
      const map = modulesMap();
      const rec = map && map[name];
      const exp = rec ? (rec.factoryFinished ? rec.exports : undefined) : get(name);
      if (!exp) return false;
      if (key === null) {
        if (!rec || typeof exp !== 'function' || wrapped.has(exp)) return wrapped.has(exp);
        const w = like(exp, make(exp));
        wrapped.add(w);
        rec.exports = w;
        if (rec.defaultExport === exp) rec.defaultExport = w;
        return true;
      }
      const orig = exp[key];
      if (typeof orig !== 'function') return false;
      if (wrapped.has(orig)) return true;
      const w = like(orig, make(orig));
      wrapped.add(w);
      try {
        exp[key] = w;
      } catch (e) {
        return false;
      }
      if (exp[key] !== w) return false;
      if (rec && key === 'default' && rec.defaultExport === orig) rec.defaultExport = w;
      return true;
    }
    /** Wrap a method on an object (an instance the client calls through), once. */
    function wrapMethod(obj, key, make) {
      if (!obj || typeof obj[key] !== 'function') return false;
      if (wrapped.has(obj[key])) return true;
      const orig = obj[key];
      const w = like(orig, make(orig));
      wrapped.add(w);
      try {
        // Where the method is the object's own, it stays with its attributes; one it inherits becomes its own, as
        // an assignment would make it.
        const d = Object.getOwnPropertyDescriptor(obj, key);
        if (d && 'value' in d) Object.defineProperty(obj, key, { value: w, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
        else obj[key] = w;
      } catch (e) {
        return false;
      }
      return obj[key] === w;
    }
    /** inner (a wrapper of ours around orig) as the page sees it: a function reading like orig (cloak.wrap). */
    function like(orig, inner) {
      return cloak.wrap(orig, (self, args) => cloak.apply(inner, self, args));
    }
    return { install, get, ready, find, candidates, whenReady, wrapExport, wrapMethod, allNames, count, via, modulesMap };
  })();
  H.install();
  let I64mod = null;
  // Looking for a module by its shape walks every module: at most once a minute per thing looked for.
  const lastScan = {};
  function shapeScanDue(what) {
    const now = Date.now();
    if (lastScan[what] && now - lastScan[what] < 60000) return false;
    lastScan[what] = now;
    return true;
  }

  // --------------------------------------------------------------- self-test
  // Each hook point: which way found it, or missing. Names only; the extractor turns these into layers.
  const hooks = {};
  function found(id, via, need) {
    hooks[id] = { ok: !!via, via: via || null, need: need || 'optional' };
    return !!via;
  }
  let lastHooks = '';
  function reportHooks(force) {
    const c = H.count();
    const payload = { t: 'hooks', backend: backend(), results: hooks, modules: c, names: H.via.names, records: H.via.records, dropped };
    const key = JSON.stringify([payload.backend, hooks, c.defined > 0, H.via]);
    if (key === lastHooks && !force) return;
    lastHooks = key;
    post(payload);
  }

  // ------------------------------------------------------------------ session
  function currentUser() {
    const cu = H.get('CurrentUser');
    if (cu && typeof cu.getID === 'function') return { via: 'CurrentUser', m: cu };
    const data = H.get('CurrentUserInitialData');
    if (data && typeof data === 'object' && 'USER_ID' in data) return { via: 'CurrentUserInitialData', data };
    return null;
  }
  function session() {
    const c = currentUser();
    if (!c) return { signedIn: null };
    try {
      if (c.m) {
        const id = String(c.m.getID());
        const nonFb = typeof c.m.getPossiblyNonFacebookUserID === 'function' ? String(c.m.getPossiblyNonFacebookUserID()) : id;
        const eimu = typeof c.m.getEIMU === 'function' ? String(c.m.getEIMU()) : '0';
        return { signedIn: nonFb !== '0' || id !== '0', id, nonFb, eimu, via: c.via };
      }
      const d = c.data;
      const id = String(d.USER_ID);
      const nonFb = String(d.NON_FACEBOOK_USER_ID ?? id);
      return { signedIn: nonFb !== '0' || id !== '0', id, nonFb, eimu: String(d.IG_USER_EIMU ?? '0'), via: c.via };
    } catch (e) {
      return { signedIn: null };
    }
  }
  function revision() {
    const sd = H.get('SiteData');
    const r = (sd && (sd.client_revision ?? sd.server_revision)) ?? W.__spin_r;
    return typeof r === 'number' || typeof r === 'string' ? String(r).slice(0, 20) : null;
  }

  // --------------------------------------------------------------- LightSpeed
  // Messenger's client database (ReStore). The inbox renders from these tables, and the client mirrors its decrypted
  // end-to-end chats into them (thread types 15 and 16), so one view covers both kinds of chat. Column names are the
  // client's own (from its stored procedures, which write them).
  const LS_TABLES = {
    threads: {
      req: ['threadKey', 'threadType'],
      cols: { threadKey: 'id', threadType: 'n', threadName: 's', threadPictureUrl: 's', lastActivityTimestampMs: 'n', lastReadWatermarkTimestampMs: 'n', muteExpireTimeMs: 'n', folderName: 's', parentThreadKey: 'id', unreadMessageCount: 'n', isHidden: 'b', threadDescription: 's' },
    },
    contacts: { req: ['id'], cols: { id: 'id', name: 's', firstName: 's', username: 's', profilePictureUrl: 's', contactType: 'n' } },
    participants: { req: ['threadKey', 'contactId'], cols: { threadKey: 'id', contactId: 'id', readWatermarkTimestampMs: 'n', deliveredWatermarkTimestampMs: 'n', nickname: 's', isAdmin: 'b' } },
    messages: {
      req: ['threadKey', 'messageId', 'timestampMs', 'senderId'],
      cols: { threadKey: 'id', messageId: 's', timestampMs: 'n', senderId: 'id', text: 's', offlineThreadingId: 'id', isAdminMessage: 'b', stickerId: 'id', isUnsent: 'b', replySourceId: 's', mentionOffsets: 'l', mentionLengths: 'l', mentionIds: 'l', isForwarded: 'b', editCount: 'n', sendStatusV2: 'n' },
    },
    reactions: { req: ['threadKey', 'messageId', 'actorId', 'reaction'], cols: { threadKey: 'id', messageId: 's', actorId: 'id', reaction: 's', timestampMs: 'n' } },
    attachments: {
      req: ['threadKey', 'messageId', 'attachmentFbid'],
      cols: { threadKey: 'id', messageId: 's', attachmentFbid: 'id', attachmentType: 'n', filename: 's', filesize: 'n', previewUrl: 's', previewUrlMimeType: 's', playableUrl: 's', playableUrlMimeType: 's', previewWidth: 'n', previewHeight: 'n', playableDurationMs: 'n', hasXma: 'b', titleText: 's' },
    },
    typing_indicator: { req: ['threadKey', 'senderId'], cols: { threadKey: 'id', senderId: 'id', expirationTimestampMs: 'n' } },
  };
  const LS_PK = { threads: ['threadKey'], messages: ['threadKey'], reactions: ['threadKey'], attachments: ['threadKey'], participants: ['threadKey'] };
  const E2EE_TYPES = new Set([15, 16]);
  const LS = {
    db: null,
    reql: null,
    via: {},
    native: new Map(), // threadKey string -> the database's own value for it (for key ranges)
    types: new Map(), // threadKey -> threadType
    own: [], // our own recent message rows: { threadKey, messageId, offlineThreadingId, timestampMs }
    watching: null,
    readError: null,
  };
  const isDb = (d) => !!d && typeof d === 'object' && typeof d.runInTransaction === 'function' && !!d.tables && typeof d.tables === 'object' && !!d.tables.messages && !!d.tables.threads;
  const fnOf = (m, key) => (typeof m === 'function' ? m : m && typeof m[key || 'default'] === 'function' ? m[key || 'default'] : null);

  async function lsFindDb() {
    if (LS.db) return LS.db;
    const ways = [
      ['LSDatabaseSingleton', () => {
        const m = H.get('LSDatabaseSingleton');
        if (!m) return undefined;
        return typeof m.getLSDatabaseSingletonPromiseOrValue === 'function' ? m.getLSDatabaseSingletonPromiseOrValue() : m.LSDatabaseSingleton;
      }],
      ['LSDatabaseSingletonLazyWrapper', () => {
        const f = fnOf(H.get('LSDatabaseSingletonLazyWrapper'));
        return f ? f() : undefined;
      }],
      ['shape', () => {
        if (!shapeScanDue('db')) return undefined;
        const c = H.find(isDb, /^(LS|MW|MAW|Messenger|ReStore)/);
        return c ? c.value : undefined;
      }],
    ];
    for (const [via, way] of ways) {
      let v;
      try {
        v = way();
      } catch (e) {
        continue;
      }
      if (v === undefined || v === null) continue;
      try {
        v = await withTimeout(v, 3000, 'the database');
      } catch (e) {
        continue;
      }
      if (isDb(v)) {
        LS.db = v;
        LS.via.db = via;
        watchTransactions(v);
        return v;
      }
    }
    return null;
  }

  function prefixMatch(table, row, prefix) {
    const pk = LS_PK[table];
    return !pk || idOf(row[pk[0]]) === idOf(prefix[0]);
  }
  /** Rows of one table, newest key first: the client's own query layer (ReQL), else the table's iterator. */
  async function lsRows(table, opts) {
    const t = LS.db.tables[table] || (typeof LS.db.table === 'function' ? LS.db.table(table) : null);
    if (!t) return [];
    const limit = opts.limit || 1000;
    const R = LS.reql;
    if (R) {
      try {
        let q = opts.asc ? R.fromTableAscending(t) : R.fromTableDescending(t);
        if (opts.prefix && typeof q.getKeyRange === 'function') q = q.getKeyRange(...opts.prefix);
        const rows = await withTimeout(R.toArrayAsync(q), 20000, `reading ${table}`);
        if (Array.isArray(rows)) {
          LS.via.read = 'ReQL';
          return (opts.prefix ? rows.filter((r) => prefixMatch(table, r, opts.prefix)) : rows).slice(0, limit);
        }
      } catch (e) {
        LS.readError = errText(e);
      }
    }
    if (typeof t.entries === 'function') {
      try {
        const it = t.entries(undefined, opts.asc ? 'asc' : 'desc');
        const out = [];
        for (let i = 0; i < limit * 50 && out.length < limit; i++) {
          const r = await withTimeout(it.next(), 5000, `iterating ${table}`);
          if (!r || r.done) break;
          const v = r.value;
          const row = v && (v.item !== undefined ? v.item : v.value !== undefined ? v.value : Array.isArray(v) ? v[1] : v);
          if (row && (!opts.prefix || prefixMatch(table, row, opts.prefix))) out.push(row);
        }
        LS.via.read = 'entries';
        return out;
      } catch (e) {
        LS.readError = errText(e);
      }
    }
    return [];
  }
  function lsPickAll(table, rows) {
    const out = [];
    for (const r of rows) {
      const p = pick(table, r, LS_TABLES[table]);
      if (!p) continue;
      out.push(p);
      if (table === 'threads') noteThread(p, r);
    }
    return out;
  }
  function noteThread(p, raw) {
    LS.native.set(p.threadKey, raw.threadKey);
    LS.types.set(p.threadKey, p.threadType);
  }

  async function lsSnapshot(lim) {
    const threads = lsPickAll('threads', await lsRows('threads', { limit: 5000 }))
      .filter((t) => !t.isHidden)
      .sort((a, b) => (b.lastActivityTimestampMs || 0) - (a.lastActivityTimestampMs || 0))
      .slice(0, lim.threads);
    const keep = new Set(threads.map((t) => t.threadKey));
    const participants = lsPickAll('participants', await lsRows('participants', { limit: 100000 })).filter((p) => keep.has(p.threadKey));
    const messages = [];
    const reactions = [];
    const attachments = [];
    const recent = threads.slice(0, lim.messageThreads);
    if (LS.reql) {
      for (const t of recent) {
        const prefix = [LS.native.get(t.threadKey)];
        messages.push(...lsPickAll('messages', await lsRows('messages', { prefix, limit: lim.perThread })));
        reactions.push(...lsPickAll('reactions', await lsRows('reactions', { prefix, limit: 1000 })));
        attachments.push(...lsPickAll('attachments', await lsRows('attachments', { prefix, limit: 500 })));
      }
    } else {
      // No key ranges: one pass over each table, grouped here.
      const want = new Set(recent.map((t) => t.threadKey));
      const per = new Map();
      for (const m of lsPickAll('messages', await lsRows('messages', { limit: 20000 }))) {
        if (!want.has(m.threadKey)) continue;
        const list = per.get(m.threadKey) || [];
        list.push(m);
        per.set(m.threadKey, list);
      }
      for (const list of per.values()) messages.push(...list.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, lim.perThread));
      reactions.push(...lsPickAll('reactions', await lsRows('reactions', { limit: 20000 })).filter((r) => want.has(r.threadKey)));
      attachments.push(...lsPickAll('attachments', await lsRows('attachments', { limit: 20000 })).filter((a) => want.has(a.threadKey)));
    }
    const mids = new Set(messages.map((m) => m.messageId));
    const people = new Set(participants.map((p) => p.contactId));
    for (const m of messages) people.add(m.senderId);
    const contacts = lsPickAll('contacts', await lsRows('contacts', { limit: 100000 })).filter((c) => people.has(c.id));
    return {
      threads,
      contacts,
      participants,
      messages,
      reactions: reactions.filter((r) => mids.has(r.messageId)),
      attachments: attachments.filter((a) => mids.has(a.messageId)),
    };
  }

  // Every row the client writes passes through its subscription manager on the way to the views that show it.
  const LS_WATCH = new Set(['threads', 'messages', 'contacts', 'participants', 'reactions', 'attachments', 'typing_indicator', 'pending_tasks']);
  let changeQueue = [];
  let changeTimer = null;
  let holdChanges = true;
  function queueChange(ch) {
    changeQueue.push(ch);
    if (changeQueue.length > 5000) changeQueue.splice(0, changeQueue.length - 5000);
    if (!holdChanges && !changeTimer) changeTimer = setTimeout(flushChanges, 80);
  }
  function flushChanges() {
    changeTimer = null;
    if (holdChanges || !changeQueue.length) return;
    const batch = changeQueue.splice(0, 400);
    post({ t: 'rows', changes: batch });
    if (changeQueue.length) changeTimer = setTimeout(flushChanges, 20);
  }
  function lsChange(table, prev, next) {
    if (!LS_WATCH.has(table)) return;
    if (table === 'pending_tasks') {
      if (next && !prev) observeTask(next);
      return;
    }
    const op = prev && next ? 'put' : next ? 'add' : prev ? 'delete' : null;
    if (!op) return;
    const row = pick(table, next || prev, LS_TABLES[table]);
    if (!row) return;
    if (table === 'threads' && next) noteThread(row, next);
    if (table === 'messages' && next && row.senderId === selfId()) {
      LS.own.push({ threadKey: row.threadKey, messageId: row.messageId, offlineThreadingId: row.offlineThreadingId || null, timestampMs: row.timestampMs });
      if (LS.own.length > 50) LS.own.shift();
    }
    const ch = { table, op, row };
    if (op === 'put' && (table === 'messages' || table === 'threads' || table === 'participants')) {
      const p = pick(table, prev, LS_TABLES[table]);
      if (p) ch.prev = p;
    }
    queueChange(ch);
  }
  function lsWatch() {
    if (LS.watching) return LS.watching;
    const sm = LS.db.subscriptionManager;
    if (
      sm &&
      H.wrapMethod(sm, 'notifyTableAndIndexSubscribers', (orig) =>
        function (table, prev, next) {
          try {
            lsChange(table, prev, next);
          } catch (e) {}
          return cloak.apply(orig, this, arguments);
        },
      )
    )
      return (LS.watching = 'subscriptionManager');
    let n = 0;
    for (const name of LS_WATCH) {
      const t = LS.db.tables[name];
      if (!t || typeof t.subscribe !== 'function') continue;
      try {
        t.subscribe((_key, change) => {
          try {
            const op = change && change.operation;
            lsChange(name, op === 'add' ? null : change.prevValue, op === 'delete' ? null : change.value);
          } catch (e) {}
        });
        n++;
      } catch (e) {}
    }
    if (n) return (LS.watching = 'table.subscribe');
    let timer = null;
    const rescan = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void lsRescan().catch(() => {}), 1500);
    };
    if (typeof LS.db.subscribeToCommit === 'function') {
      try {
        LS.db.subscribeToCommit(rescan);
        return (LS.watching = 'subscribeToCommit');
      } catch (e) {}
    }
    setInterval(rescan, 5000);
    return (LS.watching = 'poll');
  }
  // Last resort: read the threads again and the newest messages of those that moved; the extractor drops repeats.
  const lastActivity = new Map();
  async function lsRescan() {
    const threads = lsPickAll('threads', await lsRows('threads', { limit: 5000 }));
    for (const t of threads) {
      const before = lastActivity.get(t.threadKey);
      lastActivity.set(t.threadKey, t.lastActivityTimestampMs || 0);
      if (before === undefined || before === (t.lastActivityTimestampMs || 0)) continue;
      queueChange({ table: 'threads', op: 'put', row: t });
      const prefix = [LS.native.get(t.threadKey)];
      for (const m of lsPickAll('messages', await lsRows('messages', { prefix, limit: 20 }))) queueChange({ table: 'messages', op: 'put', row: m });
      for (const r of lsPickAll('reactions', await lsRows('reactions', { prefix, limit: 200 }))) queueChange({ table: 'reactions', op: 'put', row: r });
    }
  }

  // ------------------------------------------------- the client's own tasks
  // Messenger sends what you do as tasks in its own queue (pending_tasks), which it ships to the server itself. We
  // send a task only in the shape the client itself was last seen sending for that action: the labels below say
  // which action a task is (from mautrix-meta's messagix), but the fields come from the client's own task, with only
  // the chat, the message, the text and the time filled in. A shape we cannot fill exactly is not used.
  const TASK_KINDS = { 46: 'send', 29: 'react', 21: 'markRead', 33: 'unsend', 742: 'edit', 228: 'fetchMessages' };
  const VAR_KEYS = {
    thread_id: 'thread',
    thread_key: 'thread',
    thread_fbid: 'thread',
    otid: 'otid',
    offline_threading_id: 'otid',
    text: 'text',
    message_id: 'message',
    actor_id: 'self',
    reaction: 'emoji',
    timestamp_ms: 'messageTs',
    last_read_watermark_ts: 'readTs',
    reply_source_id: 'replyTo',
    reference_timestamp_ms: 'beforeTs',
    reference_message_id: 'beforeId',
  };
  const ourTasks = new Set();
  let learned = {}; // shape key -> shape
  // What the client itself passes to runInTransaction after the callback: its mode, and the name it traces the
  // transaction by. A task the client issues is credited to the transaction it last started (it issues one at a time);
  // ours pass the same as the client's own for that task.
  let clientTx = null; // { mode, name, at }
  let ourTx = false;
  const txArg = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null);
  function watchTransactions(db) {
    H.wrapMethod(db, 'runInTransaction', (orig) =>
      function (fn, mode, a, b, name) {
        if (!ourTx) clientTx = { mode: txArg(mode), name: txArg(name), at: Date.now() };
        return cloak.apply(orig, this, arguments);
      },
    );
  }
  function shapeOf(v, key, depth) {
    if (Object.prototype.hasOwnProperty.call(VAR_KEYS, key)) return { var: VAR_KEYS[key], as: typeof v === 'number' ? 'number' : 'string' };
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return { const: v };
    if (typeof v === 'string') return /^-?\d{1,4}$/.test(v) || v === '' ? { const: v } : { unknown: 'string' };
    if (Array.isArray(v)) return v.length === 0 ? { const: [] } : { unknown: 'array' };
    if (v && typeof v === 'object' && depth < 3) {
      const obj = {};
      for (const k of Object.keys(v)) obj[k] = shapeOf(v[k], k, depth + 1);
      return { obj };
    }
    return { unknown: typeof v };
  }
  const usable = (s) => !s.unknown && (!s.obj || Object.values(s.obj).every(usable));
  /** The JSON text the client would write: numbers stay numbers (64-bit ids too, written out exactly). */
  function buildJSON(s, vars) {
    if (s.var) {
      const v = vars[s.var];
      if (v === undefined || v === null) throw new Error(`no ${s.var} for this task`);
      return s.as === 'number' && /^-?\d+$/.test(String(v)) ? String(v) : JSON.stringify(String(v));
    }
    if (Object.prototype.hasOwnProperty.call(s, 'const')) return JSON.stringify(s.const);
    if (s.obj) return '{' + Object.keys(s.obj).map((k) => JSON.stringify(k) + ':' + buildJSON(s.obj[k], vars)).join(',') + '}';
    throw new Error('the client sends a field we cannot fill');
  }
  const smallNum = (v) => {
    const n = numOf(v);
    return n !== null && Math.abs(n) < 2 ** 31 ? n : null;
  };
  function observeTask(row) {
    const label = idOf(row.context);
    let payload = null;
    try {
      payload = typeof row.taskValue === 'string' ? JSON.parse(row.taskValue) : null;
    } catch (e) {}
    trace('task', `label ${label}`, payload && typeof payload === 'object' ? Object.keys(payload) : []);
    if (typeof row.taskValue === 'string' && ourTasks.has(row.taskValue)) return;
    const kind = TASK_KINDS[label];
    if (!kind || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const shape = shapeOf(payload, '', 0);
    let queue = typeof row.queueName === 'string' ? row.queueName : null;
    const thread = idOf(payload.thread_id ?? payload.thread_key ?? payload.thread_fbid);
    const message = idOf(payload.message_id);
    if (queue && thread) queue = queue.split(thread).join('{thread}');
    if (queue && message) queue = queue.split(message).join('{message}');
    const sub = kind === 'send' && payload.reply_metadata ? 'reply' : '';
    const key = sub ? `${label}:${sub}` : String(label);
    const entry = {
      kind: sub ? `${kind}:${sub}` : kind,
      label: String(label),
      queue,
      usable: usable(shape) && queue !== null,
      payload: shape,
      args: { pluginType: smallNum(row.pluginType), priority: smallNum(row.priority), syncGroupId: smallNum(row.syncGroupId), transportKey: strOf(row.transportKey) },
      tx: clientTx && Date.now() - clientTx.at < 10_000 ? { mode: clientTx.mode, name: clientTx.name } : learned[key] && learned[key].tx ? learned[key].tx : null,
      at: Date.now(),
    };
    if (!entry.usable && learned[key] && learned[key].usable) return;
    learned[key] = entry;
    post({ t: 'learned', key, shape: entry });
    // What can be done now has changed: say so at once, not on the next tick.
    setTimeout(() => {
      probe()
        .then(() => reportHooks(false))
        .catch(() => {});
    }, 0);
  }
  function i64Of(rt, n) {
    if (rt && rt.i64 && typeof rt.i64.of_float === 'function') return rt.i64.of_float(n);
    if (I64mod && typeof I64mod.of_float === 'function') return I64mod.of_float(n);
    return [0, n];
  }
  /** Issue a task the way the client's own stored procedures do: LSIssueNewTask, inside one of its transactions. */
  async function lsIssue(key, vars) {
    const shape = learned[key];
    if (!shape || !shape.usable) throw new Error('not seen yet');
    const issue = fnOf(H.get('LSIssueNewTask', true));
    const factory = fnOf(H.get('LSFactory', true));
    if (!issue || !factory) throw new Error('the client’s task modules are not loaded');
    const payload = buildJSON(shape.payload, vars);
    const queue = shape.queue.split('{thread}').join(vars.thread || '').split('{message}').join(vars.message || '');
    ourTasks.add(payload);
    if (ourTasks.size > 50) ourTasks.delete(ourTasks.values().next().value);
    const a = shape.args;
    // As the client's own transaction for this task was opened: its mode and its name (none, if it gave none).
    const t = shape.tx || {};
    const body = async (tx) => {
      const rt = factory(tx);
      await issue(queue, i64Of(rt, Number(shape.label)), payload, undefined, undefined, a.pluginType === null ? undefined : i64Of(rt, a.pluginType), a.priority === null ? undefined : i64Of(rt, a.priority), a.syncGroupId === null ? undefined : i64Of(rt, a.syncGroupId), a.transportKey || undefined, undefined, rt);
    };
    let done;
    ourTx = true;
    try {
      done = t.name === null || t.name === undefined ? LS.db.runInTransaction(body, t.mode === null || t.mode === undefined ? 'readwrite' : t.mode) : LS.db.runInTransaction(body, t.mode === null || t.mode === undefined ? 'readwrite' : t.mode, undefined, undefined, t.name);
    } finally {
      ourTx = false;
    }
    await done;
    return true;
  }
  /** Messenger's offline threading id: milliseconds shifted left 22 bits, the low bits random. */
  const newOtid = () => ((BigInt(Date.now()) << 22n) | BigInt(Math.floor(Math.random() * 4194304))).toString();
  async function waitOwn(threadKey, sinceMs, otid, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = LS.own.find((o) => o.threadKey === threadKey && (otid ? o.offlineThreadingId === otid : o.timestampMs >= sinceMs - 3000));
      if (hit) return hit;
      await sleep(150);
    }
    return null;
  }

  // ------------------------------------------------------------ the composer
  // Any chat, end-to-end encrypted ones too: the chat is opened from its own link in the page, the text goes into the
  // client's composer as typed text, and Enter sends it. What the client then does is its own.
  const onThreadPage = (key) => new RegExp(`/t/${key}(/|$)`).test(location.pathname);
  function composer() {
    const main = document.querySelector('[role="main"]') || document;
    const boxes = main.querySelectorAll('[contenteditable="true"][role="textbox"]');
    return boxes.length ? boxes[boxes.length - 1] : null;
  }
  async function until(f, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error(`${what} did not come`);
      await sleep(100);
    }
  }
  async function openThread(key) {
    if (onThreadPage(key)) return;
    const a = document.querySelector(`a[href*="/t/${key}/"], a[href$="/t/${key}"]`);
    if (!a) throw new Error('that chat is not in the page’s chat list; open it once in the live view');
    a.click();
    await until(() => onThreadPage(key), 8000, 'the chat');
  }
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  async function composerSend(key, text) {
    await openThread(key);
    const box = await until(composer, 8000, 'the composer');
    if (norm(box.textContent)) throw new Error('the composer holds a draft; send or clear it in the live view');
    box.focus();
    document.execCommand('insertText', false, text);
    await sleep(120);
    if (norm(box.textContent) !== norm(text)) {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      throw new Error('the composer did not take the text');
    }
    const at = Date.now();
    for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    const own = await waitOwn(key, at, null, 15000);
    return { nativeId: own ? own.messageId : null, via: 'composer' };
  }

  // ---------------------------------------------------------------- commands
  const isE2EE = (key) => E2EE_TYPES.has(LS.types.get(key));
  async function lsSend(cmd) {
    if (cmd.files && cmd.files.length) throw new Error('sending files to Messenger is not hooked yet');
    const e2ee = isE2EE(cmd.thread);
    const key = cmd.replyTo ? '46:reply' : '46';
    if (!e2ee && learned[key] && learned[key].usable) {
      const otid = newOtid();
      const at = Date.now();
      await lsIssue(key, { thread: cmd.thread, otid, text: cmd.text, replyTo: cmd.replyTo, self: selfId() });
      const own = await waitOwn(cmd.thread, at, otid, 15000);
      return { nativeId: own ? own.messageId : null, otid, via: 'task' };
    }
    if (cmd.replyTo) throw new Error(e2ee ? 'replies in end-to-end encrypted Messenger chats are not hooked yet' : 'replying needs one reply sent by hand in the live view first (so its shape is known)');
    return composerSend(cmd.thread, cmd.text);
  }
  async function lsTaskCommand(kind, label, cmd, vars) {
    if (isE2EE(cmd.thread)) throw new Error(`${kind} in end-to-end encrypted Messenger chats is not hooked yet`);
    if (!learned[label] || !learned[label].usable) throw new Error(`${kind} needs the client to do it once by hand in the live view first (so its shape is known)`);
    await lsIssue(label, vars);
    return { ok: true, via: 'task' };
  }
  async function lsMessageRow(thread, messageId) {
    const rows = lsPickAll('messages', await lsRows('messages', { prefix: [LS.native.get(thread)], limit: 5000 }));
    return rows.find((m) => m.messageId === messageId) || null;
  }
  async function lsHistory(cmd) {
    const native = LS.native.get(cmd.thread);
    if (native === undefined) throw new Error('unknown chat');
    const read = async () => lsPickAll('messages', await lsRows('messages', { prefix: [native], limit: 5000 })).filter((m) => !cmd.beforeTs || m.timestampMs < cmd.beforeTs);
    let msgs = await read();
    let asked = false;
    if (msgs.length < cmd.limit && !isE2EE(cmd.thread) && learned['228'] && learned['228'].usable) {
      const oldest = msgs.length ? msgs[msgs.length - 1] : null;
      try {
        await lsIssue('228', { thread: cmd.thread, beforeTs: oldest ? oldest.timestampMs : cmd.beforeTs || Date.now(), beforeId: oldest ? oldest.messageId : '' });
        asked = true;
        await sleep(2500);
        msgs = await read();
      } catch (e) {
        log('warn', `history task: ${errText(e)}`);
      }
    }
    msgs = msgs.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, cmd.limit);
    const mids = new Set(msgs.map((m) => m.messageId));
    const reactions = lsPickAll('reactions', await lsRows('reactions', { prefix: [native], limit: 5000 })).filter((r) => mids.has(r.messageId));
    const attachments = lsPickAll('attachments', await lsRows('attachments', { prefix: [native], limit: 5000 })).filter((a) => mids.has(a.messageId));
    return { messages: msgs, reactions, attachments, done: msgs.length < cmd.limit && !asked, asked };
  }
  async function lsRun(cmd) {
    switch (cmd.kind) {
      case 'send':
        return lsSend(cmd);
      case 'react': {
        const m = await lsMessageRow(cmd.thread, cmd.message);
        return lsTaskCommand('reacting', '29', cmd, { thread: cmd.thread, message: cmd.message, messageTs: m ? m.timestampMs : null, self: selfId(), emoji: cmd.remove ? '' : cmd.emoji });
      }
      case 'edit':
        return lsTaskCommand('editing', '742', cmd, { message: cmd.message, text: cmd.text });
      case 'unsend':
        return lsTaskCommand('unsending', '33', cmd, { message: cmd.message });
      case 'markRead': {
        if (!isE2EE(cmd.thread) && learned['21'] && learned['21'].usable) return lsTaskCommand('marking read', '21', cmd, { thread: cmd.thread, readTs: cmd.upToTs || Date.now() });
        await openThread(cmd.thread);
        return { ok: true, via: 'opened' };
      }
      case 'typing':
        throw new Error('typing is not hooked for Messenger');
      case 'history':
        return lsHistory(cmd);
      case 'media':
        return lsMedia(cmd.locator);
      default:
        throw new Error(`unknown command ${cmd.kind}`);
    }
  }
  /** An attachment's current link from its row (links expire and the client refreshes them), else the one we had. */
  async function lsMedia(loc) {
    let url = loc.u || null;
    try {
      if (loc.t && loc.m && loc.a) {
        const rows = lsPickAll('attachments', await lsRows('attachments', { prefix: [LS.native.get(loc.t)], limit: 5000 }));
        const row = rows.find((a) => a.messageId === loc.m && a.attachmentFbid === loc.a);
        if (row) url = (loc.f === 'preview' ? row.previewUrl : row.playableUrl || row.previewUrl) || url;
      }
    } catch (e) {}
    return mediaOf(url);
  }
  /** Bytes the page already holds (blob: and data: URLs) come from here; Meta's CDN links go to the service worker. */
  async function mediaOf(url) {
    if (!url) throw new Error('no link for that attachment');
    if (/^(blob|data):/.test(url)) {
      const res = await fetch(url);
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0], base64: btoa(s) };
    }
    return { url };
  }
  // -------------------------------------------------------------------- Slide
  // Instagram's web inbox keeps its mailbox in a Relay store: threads (XFBIGDirectViewerThread), messages
  // (SlideMessage) and people (XDTUserDict, SlideUser), filled by its queries and by the MQTT deltas it applies.
  const SL = { env: null, store: null, via: {}, emitted: new Map(), igThread: new Map(), fbThread: new Map(), igUser: new Map(), watching: null, captured: null };
  const isEnv = (e) => !!e && typeof e === 'object' && typeof e.getStore === 'function' && typeof e.commitUpdate === 'function' && typeof e.execute === 'function';
  function setEnv(env, via) {
    SL.env = env;
    SL.store = env.getStore();
    SL.via.env = via;
    return env;
  }
  /** Catch any Relay environment the next time the client uses it (queries and deltas run all the time). */
  function captureEnv() {
    for (const name of ['relay-runtime/store/RelayModernEnvironment', 'RelayModernEnvironment']) {
      const m = H.get(name);
      const cls = typeof m === 'function' ? m : m && typeof m.default === 'function' ? m.default : null;
      const proto = cls && cls.prototype;
      if (!proto) continue;
      for (const k of ['execute', 'commitUpdate', 'commitPayload', 'lookup']) {
        H.wrapMethod(proto, k, (orig) =>
          function () {
            if (!SL.captured && isEnv(this)) SL.captured = this;
            return cloak.apply(orig, this, arguments);
          },
        );
      }
      return true;
    }
    return false;
  }
  function slFindEnv() {
    if (SL.env) return SL.env;
    const p = H.get('PolarisRelayEnvironment');
    const env = p && (isEnv(p) ? p : isEnv(p.default) ? p.default : null);
    if (env) return setEnv(env, 'PolarisRelayEnvironment');
    if (SL.captured) return setEnv(SL.captured, 'RelayModernEnvironment');
    const c = shapeScanDue('env') ? H.find(isEnv, /Relay|Environment/) : null;
    if (c) return setEnv(c.value, 'shape');
    captureEnv();
    return null;
  }
  function source() {
    try {
      return SL.store.getSource();
    } catch (e) {
      return null;
    }
  }
  const recOf = (id) => {
    try {
      return typeof id === 'string' ? source().get(id) || null : null;
    } catch (e) {
      return null;
    }
  };
  /** A field by name, or by its storage key with arguments (`slide_messages(first:20)`). */
  function field(rec, name) {
    if (!rec || typeof rec !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(rec, name)) return rec[name];
    for (const k in rec) if (k.startsWith(name + '(')) return rec[k];
    return undefined;
  }
  function link(rec, name) {
    const v = field(rec, name);
    return v && typeof v === 'object' && typeof v.__ref === 'string' ? recOf(v.__ref) : null;
  }
  function links(rec, name) {
    const v = field(rec, name);
    return v && Array.isArray(v.__refs) ? v.__refs.map(recOf).filter(Boolean) : [];
  }
  function slUser(rec) {
    if (!rec || typeof rec !== 'object') return null;
    let u = null;
    if (rec.__typename === 'SlideUser') {
      u = { fbid: idOf(field(rec, 'id')), igid: idOf(field(rec, 'igid')) };
      const n = strOf(field(rec, 'name'));
      if (n) u.name = n;
      const d = link(rec, 'user_dict');
      const more = d ? slUser(d) : null;
      if (more) u = { ...more, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v)) };
    } else if (rec.__typename === 'XDTUserDict') {
      u = { igid: idOf(field(rec, 'pk')) || idOf(field(rec, 'pk_id')) || idOf(field(rec, 'id')), fbid: idOf(field(rec, 'interop_messaging_user_fbid')) || idOf(field(rec, 'fbid_v2')) };
      const un = strOf(field(rec, 'username'));
      const fn = strOf(field(rec, 'full_name'));
      const pic = strOf(field(rec, 'profile_pic_url'));
      if (un) u.username = un;
      if (fn) u.name = fn;
      if (pic) u.pic = pic;
    } else return null;
    if (!u.fbid) delete u.fbid;
    if (!u.igid) delete u.igid;
    if (!u.fbid && !u.igid) return drop('user');
    if (u.igid && u.fbid) SL.igUser.set(u.igid, u.fbid);
    return u;
  }
  function slThread(rec) {
    if (!rec || rec.__typename !== 'XFBIGDirectViewerThread') return null;
    const t = { threadFbid: idOf(field(rec, 'thread_fbid')) };
    if (!t.threadFbid) return drop('thread');
    const ig = idOf(field(rec, 'thread_id'));
    if (ig) {
      t.threadId = ig;
      SL.igThread.set(ig, t.threadFbid);
      SL.fbThread.set(t.threadFbid, ig);
    }
    const node = strOf(field(rec, 'id'));
    if (node) t.nodeId = node;
    const title = strOf(field(rec, 'thread_title'));
    if (title) t.title = title;
    const group = boolOf(field(rec, 'is_group'));
    if (group !== null) t.isGroup = group;
    const img = field(rec, 'thread_image_url');
    if (typeof img === 'string' && img) t.imageUrl = img;
    const last = numOf(field(rec, 'last_activity_timestamp_ms'));
    if (last !== null) t.lastActivityMs = last;
    if (field(rec, 'marked_as_unread') === true) t.markedUnread = true;
    const muted = boolOf(field(rec, 'is_muted'));
    if (muted !== null) t.muted = muted;
    const users = links(rec, 'users').map(slUser).filter(Boolean);
    t.users = users;
    t.receipts = links(rec, 'slide_read_receipts')
      .map((r) => ({ fbid: idOf(field(r, 'participant_fbid')) || idOf(field(r, 'participant_eimu_id')), ts: numOf(field(r, 'watermark_timestamp_ms')) }))
      .filter((r) => (r.fbid && r.ts !== null) || drop('receipt'));
    return t;
  }
  /** Media inside a message's content, wherever the content type keeps it: any record with a CDN link. */
  function slAttachments(content) {
    const out = [];
    const seen = new Set();
    const visit = (rec, depth) => {
      if (!rec || depth > 3 || seen.has(rec.__id)) return;
      seen.add(rec.__id);
      const url = strOf(field(rec, 'attachment_cdn_url')) || strOf(field(rec, 'playable_url')) || strOf(field(rec, 'video_url')) || strOf(field(rec, 'audio_src'));
      const preview = strOf(field(rec, 'preview_cdn_url'));
      if (url || preview) {
        const a = { id: idOf(field(rec, 'attachment_fbid')) || idOf(field(rec, 'id')) || String(rec.__id || out.length), type: String(rec.__typename || ''), contentType: String(content.__typename || '') };
        if (url) a.url = url;
        if (preview) a.preview = preview;
        const w = numOf(field(rec, 'preview_width'));
        const h = numOf(field(rec, 'preview_height'));
        if (w !== null) a.width = w;
        if (h !== null) a.height = h;
        const mime = strOf(field(rec, 'mime_type')) || strOf(field(rec, 'mimetype'));
        if (mime) a.mime = mime;
        const name = strOf(field(rec, 'filename'));
        if (name) a.name = name;
        out.push(a);
        return;
      }
      for (const k in rec) {
        const v = rec[k];
        if (!v || typeof v !== 'object') continue;
        if (typeof v.__ref === 'string') visit(recOf(v.__ref), depth + 1);
        else if (Array.isArray(v.__refs)) for (const id of v.__refs) visit(recOf(id), depth + 1);
      }
    };
    visit(content, 0);
    return out.slice(0, 20);
  }
  function slMessage(rec, users) {
    if (!rec || rec.__typename !== 'SlideMessage') return null;
    const m = { messageId: idOf(field(rec, 'message_id')), threadFbid: idOf(field(rec, 'thread_fbid')), senderFbid: idOf(field(rec, 'sender_fbid')), timestampMs: numOf(field(rec, 'timestamp_ms')) };
    if (!m.messageId || !m.threadFbid || !m.senderFbid || m.timestampMs === null) return drop('message');
    const text = field(rec, 'text_body');
    if (typeof text === 'string') m.text = text;
    const otid = idOf(field(rec, 'offline_threading_id'));
    if (otid) m.otid = otid;
    const reply = idOf(field(rec, 'replied_to_message_id')) || idOf(field(link(rec, 'replied_to_message'), 'message_id'));
    if (reply) m.replyTo = reply;
    const status = field(rec, 'client__send_status');
    if (typeof status === 'string') m.sendStatus = status;
    if (field(rec, 'igd_is_forwarded') === true) m.forwarded = true;
    const content = link(rec, 'content');
    if (content) {
      m.contentType = String(content.__typename || '');
      const xt = strOf(field(content, 'xma_text_body'));
      if (xt) m.xmaText = xt;
      m.attachments = slAttachments(content);
    }
    m.reactions = links(rec, 'reactions')
      .map((r) => ({ emoji: strOf(field(r, 'reaction')), senderFbid: idOf(field(r, 'sender_fbid')), ts: numOf(field(r, 'reaction_timestamp_ms')) }))
      .filter((r) => (r.emoji && r.senderFbid) || drop('reaction'));
    const edits = links(rec, 'slide_edit_history');
    if (edits.length) {
      m.edits = edits.length;
      const last = Math.max(0, ...edits.map((e) => numOf(field(e, 'timestamp_ms')) || 0));
      if (last) m.editedTs = last;
    }
    if (users) {
      const s = slUser(link(rec, 'sender'));
      if (s) users.push(s);
    }
    return m;
  }
  const authoritative = (m) => !m.sendStatus || m.sendStatus === 'AUTHORITATIVE';
  function slAll() {
    const src = source();
    let ids = [];
    try {
      ids = src.getRecordIDs();
    } catch (e) {}
    const byType = {};
    for (const id of ids) {
      const r = src.get(id);
      if (!r || typeof r.__typename !== 'string') continue;
      (byType[r.__typename] = byType[r.__typename] || []).push(r);
    }
    return byType;
  }
  function slSnapshot(lim) {
    const all = slAll();
    const users = [];
    const threads = (all.XFBIGDirectViewerThread || [])
      .map(slThread)
      .filter(Boolean)
      .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0))
      .slice(0, lim.threads);
    const keep = new Set(threads.map((t) => t.threadFbid));
    for (const t of threads) users.push(...t.users);
    for (const r of all.SlideUser || []) {
      const u = slUser(r);
      if (u) users.push(u);
    }
    const per = new Map();
    for (const r of all.SlideMessage || []) {
      const m = slMessage(r, users);
      if (!m || !keep.has(m.threadFbid) || !authoritative(m)) continue;
      const list = per.get(m.threadFbid) || [];
      list.push(m);
      per.set(m.threadFbid, list);
      SL.emitted.set(r.__id, m.messageId + '\n' + m.threadFbid);
    }
    const messages = [];
    for (const list of per.values()) messages.push(...list.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, lim.perThread));
    return { threads, users, messages };
  }

  // Every change the client makes to its store, from deltas, mutations and queries alike, is published to it.
  let slPending = new Set();
  let slTimer = null;
  function slQueue(ids, src) {
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      let gone = false;
      try {
        gone = src && src.get(id) === null;
      } catch (e) {}
      if (gone && SL.emitted.has(id)) {
        const [message, thread] = SL.emitted.get(id).split('\n');
        SL.emitted.delete(id);
        recordsOut.deleted.push({ thread, message });
      } else slPending.add(id);
    }
    if (!slTimer) slTimer = setTimeout(slFlush, 60);
  }
  const recordsOut = { messages: [], threads: [], users: [], deleted: [] };
  function slFlush() {
    slTimer = null;
    const ids = [...slPending];
    slPending = new Set();
    for (const id of ids) {
      const r = recOf(id);
      if (!r) continue;
      if (r.__typename === 'SlideMessage') {
        const m = slMessage(r, recordsOut.users);
        if (m && authoritative(m)) {
          recordsOut.messages.push(m);
          SL.emitted.set(id, m.messageId + '\n' + m.threadFbid);
        }
      } else if (r.__typename === 'XFBIGDirectViewerThread') {
        const t = slThread(r);
        if (t) recordsOut.threads.push(t);
      } else if (r.__typename === 'XDTUserDict' || r.__typename === 'SlideUser') {
        const u = slUser(r);
        if (u) recordsOut.users.push(u);
      }
    }
    if (holdChanges) return;
    if (recordsOut.messages.length || recordsOut.threads.length || recordsOut.deleted.length || recordsOut.users.length) {
      post({ t: 'records', messages: recordsOut.messages.splice(0), threads: recordsOut.threads.splice(0), users: recordsOut.users.splice(0), deleted: recordsOut.deleted.splice(0) });
    }
  }
  /** Last resort: compare every message record with what was last said about it. */
  const sigs = new Map();
  function slScan() {
    const all = slAll();
    const seen = new Set();
    for (const r of all.SlideMessage || []) {
      seen.add(r.__id);
      const m = slMessage(r, null);
      if (!m) continue;
      const sig = JSON.stringify([m.text, m.reactions, m.edits, m.sendStatus, (m.attachments || []).length]);
      if (sigs.get(r.__id) === sig) continue;
      sigs.set(r.__id, sig);
      slPending.add(r.__id);
    }
    for (const id of SL.emitted.keys()) if (!seen.has(id)) slQueue([id], { get: () => null });
    for (const r of all.XFBIGDirectViewerThread || []) {
      const t = slThread(r);
      const sig = t && JSON.stringify([t.title, t.lastActivityMs, t.receipts, t.users.length, t.markedUnread]);
      if (t && sigs.get(r.__id) !== sig) {
        sigs.set(r.__id, sig);
        slPending.add(r.__id);
      }
    }
    if (slPending.size && !slTimer) slTimer = setTimeout(slFlush, 0);
  }
  const deltaCounts = {};
  function slWatch() {
    if (SL.watching) return SL.watching;
    // The delta router: counts by type (names only), and a nudge to read what changed when publish is not hooked.
    H.wrapExport('IGDSlideMutationProcessor', 'default', (orig) =>
      function (env, delta) {
        const out = cloak.apply(orig, this, arguments);
        try {
          const tn = delta && typeof delta.__typename === 'string' ? delta.__typename : '?';
          deltaCounts[tn] = (deltaCounts[tn] || 0) + 1;
          if (SL.watching !== 'store.publish') setTimeout(slScan, 50);
        } catch (e) {}
        return out;
      },
    ) && (SL.via.deltas = 'IGDSlideMutationProcessor');
    if (
      H.wrapMethod(SL.store, 'publish', (orig) =>
        function (src) {
          let ids = null;
          try {
            ids = src && typeof src.getRecordIDs === 'function' ? src.getRecordIDs() : null;
          } catch (e) {}
          const out = cloak.apply(orig, this, arguments);
          try {
            if (ids && ids.length) slQueue(ids, src);
          } catch (e) {}
          return out;
        },
      )
    )
      return (SL.watching = 'store.publish');
    if (SL.via.deltas) return (SL.watching = 'IGDSlideMutationProcessor');
    setInterval(slScan, 4000);
    return (SL.watching = 'poll');
  }
  function slWatchTyping() {
    return H.wrapExport('IGDTypingIndicatorTransformer', 'transformIGDTypingPayload', (orig) =>
      function () {
        const out = cloak.apply(orig, this, arguments);
        try {
          if (out && out.threadIgId && out.senderIgId) {
            const thread = SL.igThread.get(String(out.threadIgId));
            const sender = SL.igUser.get(String(out.senderIgId));
            const types = H.get('IGDTypingIndicatorTypes');
            const st = types && types.IGDTypingStatus;
            const on = st && 'STOPPED_TYPING' in st ? out.activityStatus !== st.STOPPED_TYPING : Number(out.activityStatus) !== 0;
            post({ t: 'typing', thread: thread || null, threadIg: String(out.threadIgId), sender: sender || null, senderIg: String(out.senderIgId), on, ttl: numOf(out.ttl) });
          }
        } catch (e) {}
        return out;
      },
    );
  }

  // ---------------------------------------------------------------- commands
  const MAPI = {
    send: ['IGDMAPISendTextMessage', 'IGDMAPISendTextMessage'],
    react: ['IGDMAPISendReaction', 'IGDMAPISendReaction'],
    edit: ['IGDMAPIEditMessage', 'IGDMAPIEditMessage'],
    typing: ['IGDMAPISendTypingIndicator', 'default'],
  };
  // Not in the public resources: tried by name, said to be unconfirmed until a real session shows one of them.
  const UNSEND = [
    ['IGDMAPIUnsendMessage', 'IGDMAPIUnsendMessage'],
    ['IGDMAPIDeleteMessage', 'IGDMAPIDeleteMessage'],
  ];
  function mapi(which, init) {
    const [name, key] = MAPI[which];
    const f = fnOf(H.get(name, init), key);
    return f || null;
  }
  function unsendFn(init) {
    for (const [name, key] of UNSEND) {
      const f = fnOf(H.get(name, init), key);
      if (f) return { name, f };
    }
    return null;
  }
  function relayCall(name, init) {
    for (const mod of ['CometRelay', 'relay-runtime']) {
      const m = H.get(mod, init);
      if (m && typeof m[name] === 'function') return m[name].bind(m);
    }
    return null;
  }
  const eimu = () => session().eimu;
  function threadRec(fbid) {
    return recOf(`XFBIGDirectViewerThread:${fbid}`) || (slAll().XFBIGDirectViewerThread || []).find((r) => idOf(field(r, 'thread_fbid')) === fbid) || null;
  }
  function messagesOf(fbid) {
    return (slAll().SlideMessage || [])
      .map((r) => slMessage(r, null))
      .filter((m) => m && m.threadFbid === fbid)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }
  async function slSend(cmd) {
    if (cmd.files && cmd.files.length) throw new Error('sending files to Instagram is not hooked yet');
    const f = mapi('send', true);
    if (!f) throw new Error('Instagram’s send module is not loaded');
    const self = eimu();
    const at = Date.now();
    await f(SL.env, { text: cmd.text, threadFbid: cmd.thread, senderId: self, repliedMessageContent: cmd.replyTo ? { messageId: cmd.replyTo } : undefined, repliedToItemId: undefined }, undefined);
    // The module answers before the server does; its answer turns the optimistic record into the real one.
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const mine = messagesOf(cmd.thread).filter((m) => m.senderFbid === self && m.timestampMs >= at - 5000 && m.text === cmd.text);
      const real = mine.find(authoritative);
      if (real) return { nativeId: real.messageId, via: 'IGDMAPISendTextMessage' };
      if (mine.some((m) => /FAIL|ERROR/i.test(m.sendStatus || ''))) throw new Error('Instagram did not send it');
      await sleep(200);
    }
    return { nativeId: null, via: 'IGDMAPISendTextMessage' };
  }
  function commit(mutationName, variables) {
    const commitMutation = relayCall('commitMutation', true);
    const mutation = H.get(mutationName, true);
    if (!commitMutation || !mutation) throw new Error(`${mutationName} is not loaded`);
    return new Promise((resolve, reject) => {
      try {
        commitMutation(SL.env, {
          mutation,
          variables,
          onCompleted: (_r, errors) => (errors && errors.length ? reject(new Error(`Instagram refused: ${errText(errors[0])}`)) : resolve({ ok: true })),
          onError: (e) => reject(new Error(`Instagram refused: ${errText(e)}`)),
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  async function slHistory(cmd) {
    const local = () => messagesOf(cmd.thread).filter((m) => authoritative(m) && (!cmd.beforeTs || m.timestampMs < cmd.beforeTs));
    let msgs = local();
    let asked = false;
    const rec = threadRec(cmd.thread);
    const node = rec && strOf(field(rec, 'id'));
    const query = H.get('IGDMessageListOffMsysQuery.graphql', true);
    const fetchQuery = relayCall('fetchQuery', true);
    if (msgs.length < cmd.limit && node && query && fetchQuery) {
      const oldest = msgs.length ? msgs[msgs.length - 1] : null;
      try {
        const obs = fetchQuery(SL.env, query, { id: node, first: Math.min(cmd.limit, 40), ...(oldest ? { older_than_message_id: oldest.messageId } : {}) });
        await withTimeout(typeof obs.toPromise === 'function' ? obs.toPromise() : obs, 30000, 'the history query');
        asked = true;
        await sleep(200);
        msgs = local();
      } catch (e) {
        log('warn', `history query: ${errText(e)}`);
      }
    }
    msgs = msgs.slice(0, cmd.limit);
    const users = [];
    return { messages: msgs, users, done: msgs.length < cmd.limit && !asked, asked };
  }
  async function slRun(cmd) {
    switch (cmd.kind) {
      case 'send':
        return slSend(cmd);
      case 'react': {
        const f = mapi('react', true);
        if (!f) throw new Error('Instagram’s reaction module is not loaded');
        await f(SL.env, { emoji: cmd.emoji, messageId: cmd.message, reactionStatus: cmd.remove ? 'deleted' : 'created', senderId: eimu(), threadFbid: cmd.thread });
        return { ok: true, via: 'IGDMAPISendReaction' };
      }
      case 'edit': {
        const f = mapi('edit', true);
        if (!f) throw new Error('Instagram’s edit module is not loaded');
        await f(SL.env, { messageId: cmd.message, text: cmd.text, threadFbid: cmd.thread });
        return { ok: true, via: 'IGDMAPIEditMessage' };
      }
      case 'unsend': {
        const u = unsendFn(true);
        if (!u) throw new Error('Instagram’s unsend module was not found');
        await u.f(SL.env, { messageId: cmd.message, threadFbid: cmd.thread });
        return { ok: true, via: u.name };
      }
      case 'typing': {
        const rec = threadRec(cmd.thread);
        if (rec && field(rec, 'is_group') === true) return { ok: true, skipped: 'group' }; // the client sends none in groups
        const f = mapi('typing', true);
        if (!f) throw new Error('Instagram’s typing module is not loaded');
        await f(SL.fbThread.get(cmd.thread) || cmd.thread, !!cmd.on);
        return { ok: true };
      }
      case 'markRead': {
        const rec = threadRec(cmd.thread);
        const ig = rec && idOf(field(rec, 'thread_id'));
        if (!ig) throw new Error('unknown chat');
        const last = cmd.upTo || (messagesOf(cmd.thread)[0] || {}).messageId;
        if (!last) return { ok: true, skipped: 'empty' };
        await commit('useIGDMarkThreadAsReadMutation.graphql', { data: { item_id: '', message_id: last }, metadata: { ig_thread_igid: ig } });
        return { ok: true, via: 'useIGDMarkThreadAsReadMutation' };
      }
      case 'history':
        return slHistory(cmd);
      case 'media': {
        const loc = cmd.locator;
        let url = loc.u || null;
        const rec = loc.m ? recOf(`SlideMessage:${loc.m}`) : null;
        const m = rec ? slMessage(rec, null) : null;
        const a = m && (m.attachments || []).find((x) => x.id === loc.a);
        if (a) url = (loc.f === 'preview' ? a.preview : a.url || a.preview) || url;
        return mediaOf(url);
      }
      default:
        throw new Error(`unknown command ${cmd.kind}`);
    }
  }
  // -------------------------------------------------------------------- trace
  // What the client itself does when someone acts in the live view: the Relay mutations it commits, the tasks it
  // queues, the routes it asks of its encryption worker, with the names of their fields and how often. Never a value.
  const traced = new Map();
  let traceTimer = null;
  let tracePosted = 0;
  function trace(kind, name, keys) {
    const k = `${kind} ${name}`;
    const e = traced.get(k) || { kind, name: String(name).slice(0, 120), keys: [], n: 0, at: 0 };
    e.n++;
    e.at = Date.now();
    if (keys && keys.length) e.keys = keys.slice(0, 40).map((x) => String(x).slice(0, 60));
    traced.set(k, e);
    if (traced.size > 300) traced.delete(traced.keys().next().value);
    if (!traceTimer)
      traceTimer = setTimeout(() => {
        traceTimer = null;
        const items = [...traced.values()].filter((x) => x.at > tracePosted);
        tracePosted = Date.now();
        if (items.length) post({ t: 'trace', items });
      }, 2000);
  }
  function opName(op) {
    try {
      const v = typeof op === 'function' ? op() : op;
      return (v && ((v.params && v.params.name) || (v.operation && v.operation.name) || (v.fragment && v.fragment.name) || v.name)) || '?';
    } catch (e) {
      return '?';
    }
  }
  const keysOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
  function installTrace() {
    for (const mod of ['CometRelay', 'relay-runtime']) {
      H.whenReady(mod, () =>
        H.wrapExport(mod, 'commitMutation', (orig) =>
          function (env, config) {
            try {
              const vars = config && config.variables;
              trace('mutation', opName(config && config.mutation), keysOf(vars).flatMap((k) => [k, ...keysOf(vars[k]).map((s) => `${k}.${s}`)]));
            } catch (e) {}
            return cloak.apply(orig, this, arguments);
          },
        ),
      );
    }
    H.whenReady('MAWBridge', (m) => {
      try {
        const b = m && typeof m.getBridge === 'function' ? m.getBridge() : null;
        for (const k of ['sendAndReceive', 'fireAndForget'])
          H.wrapMethod(b, k, (orig) =>
            function (backend, route, payload) {
              try {
                if (route !== 'qplEvent' && route !== 'logLine') trace('bridge', `${backend}/${route}`, keysOf(payload));
              } catch (e) {}
              return cloak.apply(orig, this, arguments);
            },
          );
      } catch (e) {}
    });
  }
  // --------------------------------------------------------------------- main
  const LIMITS = { threads: 200, messageThreads: 40, perThread: 30 };
  let settings = { site: null, learned: null };
  let mode = null; // 'ls' | 'slide'
  let snap = 'none'; // none | running | sent
  let traceOn = false;
  const started = Date.now();
  let presence = null;
  function backend() {
    return mode;
  }
  const isInstagram = () => settings.site === 'instagram' || /(^|\.)instagram\.com$/.test(location.hostname);
  function selfId() {
    const s = session();
    return mode === 'slide' || (isInstagram() && s.eimu && s.eimu !== '0') ? s.eimu : s.id;
  }
  /** Defined in the page (its factory may not have run: the client loads it when someone acts, and so do we). */
  const defined = (name) => H.get(name) !== undefined || H.allNames().has(name);
  function forget(prefix) {
    for (const k of Object.keys(hooks)) if (k.startsWith(prefix)) delete hooks[k];
  }

  async function probe() {
    const ig = isInstagram();
    const s = session();
    if (mode !== 'ls' && ig) {
      const env = slFindEnv();
      found('slide.env', env ? SL.via.env : null, ig ? 'core' : 'optional');
      const slide = env && (recOf(`SlideMailbox:${s.eimu}`) || defined('IGDSlideMutationProcessor') || (slAll().SlideMessage || []).length);
      if (slide && !mode && ig) mode = 'slide';
    }
    if (mode !== 'slide') {
      const db = await lsFindDb();
      found('ls.db', db ? LS.via.db : null, ig ? 'optional' : 'core');
      if (db && !mode && (!ig || Date.now() - started > 20000)) mode = 'ls';
    }
    if (mode === 'ls') {
      forget('slide.');
      const R = H.get('ReQL');
      LS.reql = R && typeof R.toArrayAsync === 'function' && typeof R.fromTableDescending === 'function' ? R : null;
      const t = LS.db.tables.messages;
      found('ls.read', LS.reql ? 'ReQL' : t && typeof t.entries === 'function' ? 'table.entries' : null, 'core');
      const i = H.get('I64');
      I64mod = i && typeof i.to_string === 'function' ? i : null;
      found('ls.i64', I64mod ? 'I64' : 'built in', 'optional');
      found('ls.tasks', defined('LSIssueNewTask') && defined('LSFactory') ? 'LSIssueNewTask' : null, 'optional');
      const task = (k) => (learned[k] && learned[k].usable ? `task ${k} (as the client sent it)` : null);
      found('ls.send', task('46') || 'composer', 'optional');
      found('ls.reply', task('46:reply'), 'optional');
      found('ls.react', task('29'), 'optional');
      found('ls.edit', task('742'), 'optional');
      found('ls.unsend', task('33'), 'optional');
      found('ls.markRead', task('21') || 'opening the chat', 'optional');
      found('ls.history', task('228') || 'local', 'optional');
      found('maw.bridge', defined('MAWBridge') ? 'MAWBridge' : null, 'optional');
    } else if (mode === 'slide') {
      forget('ls.');
      forget('maw.');
      let src = null;
      try {
        src = SL.store.getSource();
      } catch (e) {}
      found('slide.read', src && typeof src.getRecordIDs === 'function' ? 'RecordSource' : null, 'core');
      const named = (n) => (defined(n) ? n : null);
      found('slide.send', named('IGDMAPISendTextMessage'), 'optional');
      found('slide.react', named('IGDMAPISendReaction'), 'optional');
      found('slide.edit', named('IGDMAPIEditMessage'), 'optional');
      found('slide.unsend', UNSEND.map(([n]) => n).find(defined) || null, 'optional');
      found('slide.typingOut', named('IGDMAPISendTypingIndicator'), 'optional');
      found('slide.markRead', defined('useIGDMarkThreadAsReadMutation.graphql') && (defined('CometRelay') || defined('relay-runtime')) ? 'useIGDMarkThreadAsReadMutation' : null, 'optional');
      found('slide.history', defined('IGDMessageListOffMsysQuery.graphql') ? 'IGDMessageListOffMsysQuery' : null, 'optional');
      if (snap === 'sent') found('slide.typingIn', slWatchTyping() ? 'IGDTypingIndicatorTransformer' : null, 'optional');
    }
  }
  function coreOk() {
    return Object.values(hooks).every((h) => h.ok || h.need !== 'core');
  }

  function stats(list, keys) {
    const out = { n: list.length };
    for (const k of keys) out[k] = list.filter((x) => x[k] !== undefined && x[k] !== null && x[k] !== '' && !(Array.isArray(x[k]) && !x[k].length)).length;
    return out;
  }
  async function readSnapshot() {
    if (mode === 'ls') {
      const d = await lsSnapshot(LIMITS);
      presence = {
        threads: stats(d.threads, ['threadName', 'threadPictureUrl', 'lastReadWatermarkTimestampMs', 'muteExpireTimeMs', 'unreadMessageCount']),
        e2ee: d.threads.filter((t) => E2EE_TYPES.has(t.threadType)).length,
        types: d.threads.reduce((o, t) => ((o[t.threadType] = (o[t.threadType] || 0) + 1), o), {}),
        messages: stats(d.messages, ['text', 'replySourceId', 'stickerId', 'mentionIds', 'editCount', 'offlineThreadingId']),
        contacts: stats(d.contacts, ['name', 'username', 'profilePictureUrl']),
        attachments: stats(d.attachments, ['previewUrl', 'playableUrl', 'filename', 'playableUrlMimeType']),
        reactions: d.reactions.length,
      };
      return d;
    }
    const d = slSnapshot(LIMITS);
    presence = {
      threads: stats(d.threads, ['title', 'threadId', 'nodeId', 'imageUrl', 'isGroup', 'receipts']),
      messages: stats(d.messages, ['text', 'replyTo', 'attachments', 'reactions', 'edits', 'contentType']),
      contentTypes: d.messages.reduce((o, m) => ((o[m.contentType || 'none'] = (o[m.contentType || 'none'] || 0) + 1), o), {}),
      users: stats(d.users, ['fbid', 'igid', 'username', 'name', 'pic']),
    };
    return d;
  }
  async function startSnapshot() {
    snap = 'running';
    holdChanges = true;
    try {
      found(`${mode}.changes`, mode === 'ls' ? lsWatch() : slWatch(), 'core');
      if (mode === 'slide') found('slide.deltas', SL.via.deltas || null, 'optional');
      if (mode === 'slide') found('slide.typingIn', slWatchTyping() ? 'IGDTypingIndicatorTransformer' : null, 'optional');
      const data = await readSnapshot();
      const s = session();
      post({ t: 'snapshot', backend: mode, self: { id: selfId(), fb: s.id, ig: s.nonFb, eimu: s.eimu }, ...data, dropped });
      snap = 'sent';
    } catch (e) {
      snap = 'none';
      log('warn', `snapshot failed: ${errText(e)}`);
    }
    holdChanges = false;
    flushChanges();
    if (mode === 'slide') slFlush();
  }

  let lastPage = '';
  function postPage(s) {
    const p = { t: 'page', signedIn: s.signedIn, path: location.pathname, revision: revision(), backend: mode, ready: snap === 'sent' };
    const k = JSON.stringify(p);
    if (k === lastPage) return;
    lastPage = k;
    post(p);
  }

  async function tick() {
    try {
      const s = session();
      found('modules', H.ready() ? (H.via.records !== 'none' ? H.via.records : 'require') : null, 'core');
      found('session', s.signedIn === null ? null : s.via, 'core');
      if (s.signedIn) {
        if (!traceOn) {
          installTrace();
          traceOn = true;
        }
        await probe();
        if (mode && snap === 'none' && coreOk()) await startSnapshot();
      }
      postPage(s);
      reportHooks(false);
    } catch (e) {
      log('warn', `tick: ${errText(e)}`);
    }
    const age = Date.now() - started;
    const missing = Object.values(hooks).some((h) => !h.ok);
    setTimeout(tick, snap === 'sent' ? (missing ? 15000 : 60000) : age > 120000 ? 5000 : 1000);
  }

  // ------------------------------------------------------------------ survey
  function exportShape(e) {
    if (e === undefined) return null;
    if (typeof e === 'function') return `function/${e.length}`;
    if (!e || typeof e !== 'object') return typeof e;
    const out = {};
    for (const k of Object.keys(e).slice(0, 30)) {
      try {
        out[k] = typeof e[k] === 'function' ? `function/${e[k].length}` : typeof e[k];
      } catch (err) {
        out[k] = '?';
      }
    }
    return out;
  }
  async function survey() {
    const names = [...H.allNames()];
    const skip = /\.graphql$|RelayOperation$|\$Parameters$|\.react$|Icon|Svg|\.svg/;
    const GROUPS = { LS: /^LS[A-Z]/, MAW: /^MAW/, MW: /^MW[A-Z]/, IGD: /^(IGD|useIGD)/, Slide: /Slide/, Relay: /^(relay-runtime|CometRelay|react-relay)/, Mqtt: /Mqtt|MQTT/ };
    const counts = {};
    const lists = {};
    for (const [g, re] of Object.entries(GROUPS)) {
      const l = names.filter((n) => re.test(n));
      counts[g] = l.length;
      lists[g] = l.filter((n) => !skip.test(n)).sort().slice(0, 400);
    }
    const ACT = /(Send|React|Reaction|MarkRead|MarkThreadRead|Typing|Unsend|Edit|DeleteMessage|Fetch(Messages|More|Thread)|Composer)/;
    const actions = names
      .filter((n) => ACT.test(n) && !skip.test(n))
      .sort()
      .slice(0, 300)
      .map((n) => ({ name: n, ran: H.get(n) !== undefined, shape: exportShape(H.get(n)) }));
    const mutations = names.filter((n) => /Mutation\.graphql$/.test(n) && /Direct|IGD|Slide|Messenger|LS|MW/.test(n)).sort().slice(0, 200);
    const sprocs = [];
    for (const n of names) {
      if (!/^LS/.test(n)) continue;
      const f = fnOf(H.get(n));
      if (f && typeof f.__sproc_name__ === 'string') sprocs.push({ name: n, sproc: f.__sproc_name__, tables: Array.isArray(f.__tables__) ? f.__tables__.slice(0, 10) : [] });
    }
    let data = null;
    if (mode === 'ls') data = { tables: Object.keys(LS.db.tables || {}).length, read: LS.via.read || null, readError: LS.readError };
    if (mode === 'slide') {
      const all = slAll();
      data = { records: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.length]).filter(([k]) => /Slide|XFBIG|XDTUser|Mailbox/.test(k))) };
    }
    return {
      site: settings.site,
      host: location.hostname,
      path: location.pathname,
      backend: mode,
      ready: snap === 'sent',
      revision: revision(),
      modules: H.count(),
      via: H.via,
      hooks,
      counts,
      lists,
      actions,
      mutations,
      sprocs: sprocs.filter((s) => ACT.test(s.sproc) || /Task|Thread|Message/.test(s.sproc)).slice(0, 300),
      data,
      presence,
      deltas: deltaCounts,
      trace: [...traced.values()],
      learned: Object.fromEntries(Object.entries(learned).map(([k, v]) => [k, { kind: v.kind, usable: v.usable, queue: v.queue, at: v.at }])),
      dropped,
      age: Math.round((Date.now() - started) / 1000),
    };
  }

  // ----------------------------------------------------------------- commands
  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    if (typeof s.site === 'string') settings.site = s.site;
    if (s.learned && typeof s.learned === 'object') {
      for (const [k, v] of Object.entries(s.learned)) {
        if (!v || typeof v !== 'object' || typeof v.label !== 'string' || !v.payload || typeof v.queue !== 'string') continue;
        if (!learned[k] || (v.at || 0) > (learned[k].at || 0)) learned[k] = { ...v, usable: v.usable === true && usable(v.payload) };
      }
    }
  }
  async function runCommand(cmd) {
    switch (cmd.kind) {
      case 'settings':
        applySettings(cmd.settings);
        return { ok: true };
      case 'survey':
        return survey();
      case 'snapshot': {
        if (!mode || snap !== 'sent') throw new Error('the app has not finished loading');
        const s = session();
        return { backend: mode, self: { id: selfId(), fb: s.id, ig: s.nonFb, eimu: s.eimu }, ...(await readSnapshot()), dropped };
      }
    }
    if (!mode || snap !== 'sent') throw new Error('the app has not finished loading');
    return mode === 'ls' ? lsRun(cmd) : slRun(cmd);
  }

  cloak.onDown((p) => {
    if (p.t === 'settings') return void applySettings(p.settings);
    if (p.t !== 'cmd') return;
    Promise.resolve()
      .then(() => runCommand(p.cmd || {}))
      .then((result) => post({ t: 'reply', id: p.id, ok: true, result }))
      .catch((err) => post({ t: 'reply', id: p.id, ok: false, error: errText(err) }));
  });

  post({ t: 'hook', page: location.origin + location.pathname });
  setTimeout(tick, 300);
  setInterval(() => {
    try {
      postPage(session());
    } catch (e) {}
  }, 3000);
  setInterval(() => reportHooks(true), 30000);
})();
