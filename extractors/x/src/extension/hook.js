/*
 * MAIN-world content script on x.com, at document_start. Signed in, x.com is X's own client, "responsive-web" (webpack,
 * React, Redux); signed out it is "x-web" (ES modules built by Vite and Rolldown). Either way its DMs are XChat, a Module
 * Federation "embed" whose logic is a Kotlin/JS core (@x-clients/dm-core, shared with X's phone apps) that keeps legacy
 * DMs and encrypted XChat conversations in one SQLite database (a worker on OPFS) and decrypts in the page. The embed's
 * own React (19) draws it into shadow roots. docs/x.md has what this was read from. The notifications and profiles
 * are read through responsive-web's own endpoints ("the feed", below).
 *
 * So this hooks where the client holds plaintext, as the Discord hook does, by other means:
 *
 *   - React's DevTools hook (__REACT_DEVTOOLS_GLOBAL_HOOK__), installed before React loads: both React copies (the
 *     host's and the embed's) register with it and report every commit. Fallback: React's own container keys
 *     (__reactContainer$…) on the page and in open shadow roots.
 *   - In the fiber trees, the Kotlin objects the UI holds: the object graph (WebDmObjectGraph), the inbox's
 *     conversation list component, the open conversation's DM component and its composer. Found by their Kotlin class
 *     names (Kotlin/JS keeps them as $metadata$.simpleName), or failing that by the names of what they export.
 *   - Kotlin's event classes (DmEvent, ChatComposerEvent, ConversationListEvent, with their subclasses as statics),
 *     from the dm-core module's exports: the chunk the page already loaded is imported again (the module map gives the
 *     same instance, no request). Fallback: the classes of the events the UI itself sends.
 *
 * Reading is subscribing to the components' state flows (`{ state, subscribe }`) and forwarding a whitelisted copy.
 * Commands are the events the UI sends for the same click: open a row, scroll to the top, type and press send, pick a
 * reaction, delete for everyone. It never makes a request itself, except reading a media file the page would show
 * (a blob it already has, or a twimg URL with the page's cookies, as an <img> would).
 *
 * Conversations this hook opens to read are "quiet": the UI's own read marking (VisibleReadableItemsChanged, sent for
 * whatever is on screen) is held back for them, so reading history does not mark anything read. markRead sends that
 * same event on purpose.
 *
 * Diagnostics (`diagnose`) give shapes only: Kotlin class names, key names, value types, counts. Never values.
 * It talks to content.js over the channel in main-world.js (put in below when the extension is copied), which also
 * keeps the DevTools hook's functions and the onEvent wrappers looking native or like what they wrap. Plain JS on
 * purpose (no build step).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  const HOOK_VERSION = 1;
  const settings = { testOrigin: null };

  const post = (payload) => cloak.send(payload); // a value that does not clone is dropped on the way
  const log = (level, msg) => post({ t: 'log', level, msg: String(msg).slice(0, 300) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const human = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

  // ------------------------------------------------------------------ counters
  // Numbers only: what the self-test and the diagnostics report.
  const counts = { commits: 0, scans: 0, fibers: 0, readsHeld: 0, readsSent: 0, modulesScanned: 0, events: 0, dropped: {} };
  const drop = (kind) => {
    counts.dropped[kind] = (counts.dropped[kind] || 0) + 1;
  };

  // --------------------------------------------------------------- hook points
  // Each is found or missing, and how it was found. Names are stable: the extractor's status shows them.
  const HOOKS = ['react', 'graph', 'classes', 'inbox', 'open', 'history', 'read', 'quietReads', 'send', 'reply', 'edit', 'unsend', 'reactions', 'attach', 'self', 'requests', 'answer', 'openDirect', 'createGroup', 'addMembers', 'groupInfo', 'typing', 'forward'];
  const hooks = {};
  for (const n of HOOKS) hooks[n] = { ok: false, via: null };
  // Checked only once a conversation is open (its component, its composer): pending until then, not missing.
  hooks.quietReads.via = 'pending';
  hooks.attach.via = 'pending';
  let reportTimer = null;
  function mark(name, ok, via) {
    const h = hooks[name];
    if (!h || (h.ok === ok && h.via === (ok ? via : null))) return;
    h.ok = ok;
    h.via = ok ? via : null;
    if (!reportTimer) reportTimer = setTimeout(reportSelfTest, 250);
  }
  function selfTest() {
    const out = {};
    for (const n of Object.keys(hooks)) out[n] = { ok: hooks[n].ok, via: hooks[n].via };
    return {
      version: HOOK_VERSION,
      hooks: out,
      counts: {
        renderers: renderers.length,
        roots: rootCount(),
        modules: chunkUrls.size,
        modulesScanned: counts.modulesScanned,
        conversationsOpen: dms.size,
        readsHeld: counts.readsHeld,
        dropped: Object.assign({}, counts.dropped),
      },
    };
  }
  function reportSelfTest() {
    reportTimer = null;
    post({ t: 'selftest', ...selfTest() });
  }

  // ------------------------------------------------------------- value helpers
  const fn = (v) => typeof v === 'function';
  function get(o, k) {
    try {
      return o == null ? undefined : o[k];
    } catch (e) {
      return undefined;
    }
  }
  function first(o, keys) {
    for (const k of keys) {
      const v = get(o, k);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  }
  /** The Kotlin class name of an object (Kotlin/JS keeps $metadata$.simpleName in production builds). */
  function kname(o) {
    try {
      const m = o && typeof o === 'object' && o.constructor && o.constructor.$metadata$;
      return m && typeof m.simpleName === 'string' ? m.simpleName : null;
    } catch (e) {
      return null;
    }
  }
  const kclassName = (f) => {
    try {
      return (f && f.$metadata$ && f.$metadata$.simpleName) || null;
    } catch (e) {
      return null;
    }
  };
  /** Kotlin class names up the prototype chain: an event's own class, then its sealed parent. */
  function knames(o) {
    const out = [];
    try {
      let p = Object.getPrototypeOf(o);
      for (let i = 0; p && p !== Object.prototype && i < 6; i++) {
        const n = kclassName(p.constructor);
        if (n) out.push(n);
        p = Object.getPrototypeOf(p);
      }
    } catch (e) {}
    return out;
  }
  /** A Kotlin StateFlow as the embed exports it: `{ state, subscribe(cb) -> { cancel() } }`. */
  const isFlow = (x) => !!x && typeof x === 'object' && fn(get(x, 'subscribe')) && 'state' in x;
  const valueOf = (x) => (isFlow(x) ? get(x, 'state') : x);
  /** Kotlin lists, sets, arrays and iterables as an array. */
  function arr(x) {
    if (x == null || typeof x === 'string') return [];
    if (Array.isArray(x)) return x;
    for (const m of ['asJsReadonlyArrayView', 'asJsReadonlySetView']) {
      try {
        if (fn(x[m])) return Array.from(x[m]());
      } catch (e) {}
    }
    try {
      if (fn(x.toArray)) {
        const a = x.toArray();
        if (Array.isArray(a)) return a;
      }
    } catch (e) {}
    try {
      if (fn(x[Symbol.iterator])) return Array.from(x);
    } catch (e) {}
    return [];
  }
  function entries(x) {
    if (!x || typeof x !== 'object') return [];
    try {
      if (fn(x.asJsReadonlyMapView)) return Array.from(x.asJsReadonlyMapView().entries());
    } catch (e) {}
    try {
      if (x instanceof Map) return Array.from(x.entries());
    } catch (e) {}
    return [];
  }
  /** An id from whatever holds it: a string, a number or bigint, or a Kotlin value class (`id`, `str`, `userIdString`, …). */
  function idOf(v, depth) {
    depth = depth || 0;
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() ? v : null;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
    if (typeof v === 'bigint') return String(v);
    if (typeof v !== 'object' || depth > 3) return null;
    for (const k of ['id', 'str', 'value', 'userIdString', 'idString', 'stringValue', 'conversationId', 'convId', 'rawValue']) {
      const r = idOf(get(v, k), depth + 1);
      if (r) return r;
    }
    return null;
  }
  const seqOf = (v) => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : idOf(v));
  /** Milliseconds since the epoch from a number (s, ms or µs), a bigint, a Date, an ISO string or a Kotlin Instant. */
  function msOf(v, depth) {
    depth = depth || 0;
    if (v == null) return null;
    if (typeof v === 'bigint') return msOf(Number(v));
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v <= 0) return null;
      return Math.round(v > 1e14 ? v / 1000 : v > 1e11 ? v : v * 1000);
    }
    if (typeof v === 'string') {
      if (/^\d+$/.test(v)) return msOf(Number(v));
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    if (v instanceof Date) return v.getTime();
    if (typeof v !== 'object' || depth > 2) return null;
    try {
      if (fn(v.toEpochMilliseconds)) return msOf(Number(v.toEpochMilliseconds()));
    } catch (e) {}
    const s = get(v, 'epochSeconds');
    if (s != null) return Number(s) * 1000 + Math.floor(Number(get(v, 'nanosecondsOfSecond') || 0) / 1e6);
    const w = get(v, 'inWholeMilliseconds');
    if (w != null) return msOf(Number(w));
    for (const k of ['instant', 'value', 'timestamp', 'timestampValue', 'millis']) {
      const r = msOf(get(v, k), depth + 1);
      if (r) return r;
    }
    return null;
  }
  const strOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof get(v, 'text') === 'string' ? get(v, 'text') : null);
  const boolOf = (v) => (typeof v === 'boolean' ? v : null);
  const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null);
  const enumName = (v) => (v && typeof v === 'object' && typeof get(v, 'name') === 'string' ? get(v, 'name') : typeof v === 'string' ? v : null);
  const urlOf = (v) => {
    const s = typeof v === 'string' ? v : idOf(v);
    return s && /^(https?:|blob:|data:)/.test(s) ? s : null;
  };

  // ------------------------------------------------------------------- React
  // Both React copies (x-web's and the XChat embed's) call inject() when react-dom loads and onCommitFiberRoot after
  // every commit, the way the React DevTools extension is told. A hook that is already there is wrapped, not replaced.
  const renderers = [];
  const devtoolsRoots = new Set();
  let scanSoon = null;
  function onCommit(root) {
    counts.commits++;
    if (root && root.current) devtoolsRoots.add(root);
    // A conversation we are opening quietly: find its component before React's effects run (they mark reads).
    if (pendingQuiet.size) {
      try {
        scanRoot(root, new WeakSet(), null);
      } catch (e) {}
    }
    if (!scanSoon) scanSoon = setTimeout(() => ((scanSoon = null), scan()), 1000);
  }
  function installDevtools() {
    const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (existing && typeof existing === 'object') {
      const inject = existing.inject;
      const commit = existing.onCommitFiberRoot;
      // Each reads like the one it wraps (or like a native, where there was none).
      const like = (orig, name, length, body) => (fn(orig) ? cloak.wrap(orig, body) : cloak.native({ [name]: (...a) => body(undefined, a) }[name], name, length));
      existing.inject = like(inject, 'inject', 1, (self, args) => {
        const r = args[0];
        renderers.push({ version: String((r && r.version) || ''), pkg: String((r && r.rendererPackageName) || '') });
        mark('react', true, 'devtools');
        return fn(inject) ? cloak.apply(inject, self, args) : renderers.length;
      });
      existing.onCommitFiberRoot = like(commit, 'onCommitFiberRoot', 2, (self, args) => {
        onCommit(args[1]);
        return fn(commit) ? cloak.apply(commit, self, args) : undefined;
      });
      return;
    }
    let next = 1;
    const hook = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject(r) {
        const id = next++;
        this.renderers.set(id, r);
        renderers.push({ version: String((r && r.version) || ''), pkg: String((r && r.rendererPackageName) || '') });
        mark('react', true, 'devtools');
        return id;
      },
      onCommitFiberRoot(_id, root) {
        onCommit(root);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      setStrictMode() {},
      checkDCE() {},
    };
    // Its functions read like natives: methods (no prototype), each with its name and length.
    for (const k of Object.keys(hook)) if (typeof hook[k] === 'function') cloak.native(hook[k], k, hook[k].length);
    try {
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true, writable: true, enumerable: false });
    } catch (e) {
      log('warn', 'could not install the React DevTools hook');
    }
  }

  /** Fallback: React's container keys on the page and in open shadow roots (the embed draws into shadow roots). */
  let lastDomRootsAt = 0;
  const domRootSet = new Set();
  function domRoots() {
    if (Date.now() - lastDomRootsAt < 10_000) return domRootSet;
    lastDomRootsAt = Date.now();
    domRootSet.clear();
    let seen = 0;
    const visit = (root) => {
      let els;
      try {
        els = root.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (const el of els) {
        if (++seen > 60_000) return;
        if (el.shadowRoot) visit(el.shadowRoot);
        let keys;
        try {
          keys = Object.keys(el);
        } catch (e) {
          continue;
        }
        for (const k of keys) {
          if (!k.startsWith('__reactContainer$')) continue;
          const f = el[k];
          const fr = f && f.stateNode;
          if (fr && fr.current) domRootSet.add(fr);
        }
      }
    };
    visit(document);
    if (domRootSet.size && !hooks.react.ok) mark('react', true, 'dom');
    return domRootSet;
  }
  function allRoots() {
    const out = new Set(devtoolsRoots);
    if (!out.size || !found.graph) for (const r of domRoots()) out.add(r);
    return out;
  }
  const rootCount = () => allRoots().size;

  /** Every fiber under a root, depth first, at most `max`. */
  function* walk(root, max) {
    const start = root && root.current;
    let node = start;
    let n = 0;
    while (node && n < max) {
      yield node;
      n++;
      if (node.child) {
        node = node.child;
        continue;
      }
      while (node && !node.sibling) {
        node = node.return;
        if (!node || node === start) return;
      }
      node = node && node.sibling;
    }
  }
  const CONTEXT = Symbol.for('react.context');
  const PROVIDER = Symbol.for('react.provider');
  /** The objects a fiber holds: a context provider's value, props, hook states, useMemo results, compiler caches. */
  function* held(f) {
    const p = f.memoizedProps;
    if (p && typeof p === 'object') {
      const t = f.type;
      if ('value' in p && (f.tag === 10 || (t && (t.$$typeof === CONTEXT || t.$$typeof === PROVIDER)))) yield ['provider', p.value];
      for (const k in p) {
        if (k === 'children' || k === 'value') continue;
        const v = p[k];
        if (v && typeof v === 'object') yield ['prop', v];
      }
    }
    if (f.tag === 0 || f.tag === 11 || f.tag === 15) {
      let h = f.memoizedState;
      for (let i = 0; h && typeof h === 'object' && i < 80; i++, h = h.next) {
        const s = h.memoizedState;
        if (!s || typeof s !== 'object') continue;
        if (Array.isArray(s)) {
          if (s.length === 2 && (Array.isArray(s[1]) || s[1] === null)) {
            yield ['memo', s[0]];
            if (s[0] && typeof s[0] === 'object' && 'component' in s[0]) yield ['memo', s[0].component];
          }
          continue;
        }
        yield ['state', s];
        if ('component' in s) yield ['state', s.component];
        if ('current' in s && s.current && typeof s.current === 'object') yield ['ref', s.current];
      }
      const cache = f.updateQueue && f.updateQueue.memoCache;
      const data = cache && cache.data;
      if (Array.isArray(data)) for (const block of data) if (Array.isArray(block)) for (const v of block) if (v && typeof v === 'object') yield ['cache', v];
    }
  }

  // ------------------------------------------------------------ what it finds
  const found = { graph: null, list: null, listVia: null, requestsUi: null };
  /** Open conversations: conversation id → { dm, via, sub, raw } */
  const dms = new Map();
  let pinComponent = null;
  const providerKinds = new Map();

  function setGraph(g, via) {
    if (found.graph === g) return;
    found.graph = g;
    mark('graph', true, via);
    log('info', `graph found by ${via}`);
    findSelf();
    void findClasses();
  }

  /** What one fiber value is, if it is one of ours: true when it is. */
  function classify(v, where, seen) {
    if (!v || typeof v !== 'object') return false;
    feedOffer(v, where);
    const n = kname(v);
    if (where === 'provider') providerKinds.set(n || 'plain', (providerKinds.get(n || 'plain') || 0) + 1);
    if (n === 'WebDmObjectGraph' || (fn(get(v, 'conversationListComponent')) && fn(get(v, 'convComponentContainer')))) {
      if (!found.graph) setGraph(v, n === 'WebDmObjectGraph' ? 'name' : 'shape');
      return true;
    }
    if (n === 'DefaultConversationListComponent' || (isFlow(get(v, 'state')) && fn(get(v, 'onEvent')) && 'inboxCategoryDropdownComponent' in v)) {
      if (seen) seen.lists.push([v, n === 'DefaultConversationListComponent' ? 'name' : 'shape']);
      return true;
    }
    if (n === 'DefaultDmComponent' || (isFlow(get(v, 'state')) && fn(get(v, 'onEvent')) && get(v, 'composer') && fn(get(v, 'messageActions')))) {
      addDm(v, n === 'DefaultDmComponent' ? 'name' : 'shape');
      if (seen) seen.dms.add(v);
      return true;
    }
    if (n && /PinEntryComponent$/.test(n)) {
      pinComponent = v;
      return true;
    }
    // The Requests page's component (the requests hook's fallback): by name, or a state with tabs and previews.
    if (n === 'DefaultMessageRequestsComponent' || (isFlow(get(v, 'state')) && fn(get(v, 'onEvent')) && hasField(valueOf(get(v, 'state')) || {}, 'selectedTab') && hasField(valueOf(get(v, 'state')) || {}, 'confirmBlockConvId'))) {
      if (v !== requestsComp) found.requestsUi = v;
      return true;
    }
    return false;
  }

  // Roots where something of ours was found are scanned every time; the others (x-web's own, large) at most every
  // 30 s, or when nothing has been found yet.
  const hotRoots = new WeakSet();
  let lastFullScan = 0;
  let scanning = false;
  function scan() {
    if (scanning) return;
    scanning = true;
    counts.scans++;
    const before = new Set(dms.keys());
    const seen = { lists: [], dms: new Set() };
    providerKinds.clear();
    pinComponent = null;
    let fibers = 0;
    const full = !found.graph || Date.now() - lastFullScan > 30_000;
    if (full) lastFullScan = Date.now();
    try {
      const visited = new WeakSet();
      for (const root of allRoots()) if (full || hotRoots.has(root)) fibers += scanRoot(root, visited, seen);
    } finally {
      scanning = false;
    }
    counts.fibers = fibers;
    // The inbox's list component: the one already followed while it is still there (the drawer and the chat page may
    // each have one), else the first found.
    if (seen.lists.length && !seen.lists.some(([l]) => l === found.list)) setList(seen.lists[0][0], seen.lists[0][1]);
    const seenDms = seen.dms;
    // The composer's file input exists only while a conversation is open: look for it then.
    if (dms.size && !hooks.attach.ok && composerFileInput()) mark('attach', true, 'input');
    // Components the UI dropped (a conversation closed): stop following them.
    for (const id of before) {
      const e = dms.get(id);
      if (e && !seenDms.has(e.dm)) {
        try {
          e.sub && e.sub.cancel();
        } catch (err) {}
        dms.delete(id);
        post({ t: 'closed', conv: id });
      }
    }
    pageCheck();
  }
  function scanRoot(root, visited, seen) {
    let n = 0;
    let hit = false;
    for (const f of walk(root, 80_000)) {
      n++;
      try {
        for (const [where, v] of held(f)) {
          if (!v || typeof v !== 'object' || visited.has(v)) continue;
          visited.add(v);
          if (classify(v, where, seen)) hit = true;
        }
      } catch (e) {
        /* a fiber whose values throw: skipped */
      }
    }
    if (hit) hotRoots.add(root);
    return n;
  }

  // ---------------------------------------------------------------- the inbox
  let listSub = null;
  let inboxTimer = null;
  let lastInbox = '';
  /** Conversation id → the Kotlin preview object, for RowClicked. */
  const previewObjects = new Map();
  function setList(v, via) {
    if (found.list === v) return;
    try {
      listSub && listSub.cancel();
    } catch (e) {}
    found.list = v;
    found.listVia = via;
    mark('inbox', true, via);
    learnFromComponent(v, 'ConversationListEvent');
    const flow = get(v, 'state');
    try {
      listSub = flow.subscribe(() => inboxSoon());
    } catch (e) {
      listSub = null;
      log('warn', 'could not follow the inbox state');
    }
    inboxSoon();
  }
  function inboxSoon() {
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(emitInbox, 400);
  }
  /** Like scrolling to the end of the list: more conversations, a page at a time, up to INBOX_MAX, every few seconds. */
  const INBOX_MAX = 100;
  let moreAt = 0;
  let moreTries = 0;
  let moreCount = -1;
  function loadMore(st, count) {
    const L = K.ConversationListEvent;
    if (!L || !get(st, 'hasMoreItemsInfo') || count >= INBOX_MAX || get(st, 'isLoadingConversations')) return;
    if (Date.now() - moreAt < human(3000, 6000)) return;
    if (count === moreCount && ++moreTries > 2) return;
    if (count !== moreCount) moreTries = 0;
    moreCount = count;
    let ev = null;
    try {
      ev = get(L, 'ScrolledToBottomOfConversations');
    } catch (e) {}
    if (!ev || typeof ev !== 'object') return;
    moreAt = Date.now();
    try {
      get(found.list, 'onEvent').call(found.list, ev);
    } catch (e) {}
  }
  function emitInbox(force) {
    if (!found.list) return null;
    const st = valueOf(get(found.list, 'state'));
    if (!st) return null;
    const raw = inboxRaw(st);
    loadMore(st, raw.conversations.length);
    const key = JSON.stringify(raw);
    if (key !== lastInbox || force) {
      lastInbox = key;
      post({ t: 'inbox', ...raw });
    }
    requestsCheck(st);
    return raw;
  }
  function inboxRaw(st) {
    const list = arr(first(st, ['previews', 'previewItems']));
    const conversations = [];
    previewObjects.clear();
    for (const p of list.slice(0, 500)) {
      const c = convRaw(p);
      if (c) conversations.push(c);
      else drop('conversation');
    }
    const typing = [];
    for (const [k, v] of entries(get(st, 'typingIndicatorsByConversation'))) {
      const conv = idOf(k);
      if (!conv) continue;
      const who = arr(v).map((u) => idOf(first(u, ['userId', 'id', 'senderId', 'user']))).filter(Boolean);
      typing.push({ conv, users: who.length ? who : idOf(first(v, ['userId', 'senderId'])) ? [idOf(first(v, ['userId', 'senderId']))] : [] });
    }
    return {
      conversations,
      typing,
      loading: !!get(st, 'isLoadingConversations') || !!get(st, 'isInitializing'),
      loadedFromDb: boolOf(get(st, 'hasLoadedConversationsFromDb')),
      keysChecked: boolOf(get(st, 'hasCheckedKeypairsFromDb')),
      more: !!get(st, 'hasMoreItemsInfo'),
      failed: !!get(st, 'pullFailureReason'),
    };
  }
  /** Whether a conversation id names a group: its Kotlin class (Group / OneOnOne), else the id's form. */
  function groupOf(idObj, id) {
    const n = kname(idObj);
    if (n && /group/i.test(n)) return true;
    if (n && /one ?on ?one|direct/i.test(n)) return false;
    if (/^\d+-\d+$/.test(id)) return false;
    if (/^g\d+/.test(id)) return true;
    return null;
  }
  /** Users found inside an object, by their shape (a screen name next to an id), at most `max`, a few levels deep. */
  function usersIn(o, max) {
    const out = new Map();
    const seen = new WeakSet();
    const visit = (v, depth) => {
      if (!v || typeof v !== 'object' || seen.has(v) || out.size >= max || depth > 4) return;
      seen.add(v);
      const u = userRaw(v);
      if (u) {
        out.set(u.id, u);
        return;
      }
      if (Array.isArray(v) || fn(get(v, 'asJsReadonlyArrayView'))) {
        for (const x of arr(v).slice(0, 50)) visit(x, depth + 1);
        return;
      }
      for (const k of Object.keys(v)) {
        if (!/^[a-z][A-Za-z]{2,}$/.test(k)) continue;
        visit(get(v, k), depth + 1);
      }
    };
    visit(o, 0);
    return [...out.values()];
  }
  function userRaw(v) {
    if (!v || typeof v !== 'object') return null;
    const screenName = first(v, ['screenName', 'handle', 'username']);
    if (typeof screenName !== 'string') return null;
    const id = idOf(first(v, ['userId', 'id', 'userIdString', 'restId', 'userIdentifier']));
    if (!id) return null;
    return {
      id,
      screenName,
      displayName: strOf(first(v, ['displayName', 'name'])),
      avatarUrl: urlOf(first(v, ['avatarUrl', 'profileImageUrl', 'profileImageUrlHttps'])),
    };
  }
  function convRaw(p, request) {
    const pv = get(p, 'preview') || p;
    const md = get(p, 'metadata');
    const meta = md && !get(md, 'attributes') && get(md, 'metadata') ? get(md, 'metadata') : md;
    const idObj = first(p, ['conversationId']) || get(pv, 'conversationId') || get(meta, 'conversationId');
    const id = idOf(idObj);
    if (!id) return null;
    if (!request) previewObjects.set(id, p);
    const attrs = get(meta, 'attributes');
    const latest = get(pv, 'latestMessagePreview');
    return {
      id,
      kind: kname(p),
      legacy: boolOf(get(p, 'isLegacy')),
      group: groupOf(idObj, id),
      title: strOf(get(attrs, 'customTitle')),
      avatarUrl: urlOf(get(attrs, 'customAvatarUrl')),
      archived: boolOf(get(attrs, 'archived')),
      description: strOf(get(attrs, 'customDescription')),
      muted: boolOf(get(attrs, 'muted')),
      unread: numOf(get(p, 'unreadCount')),
      unreadByMe: boolOf(get(p, 'isUnreadByMe')),
      lastTs: msOf(get(pv, 'timestamp')),
      lastReadSeq: seqOf(get(pv, 'lastReadSequenceNumber')),
      lastSeq: seqOf(first(latest, ['sequenceNumber'])) || seqOf(get(pv, 'sequenceNumber')),
      users: usersIn(md, 20),
    };
  }

  // ----------------------------------------------------------- conversations
  const quiet = new Set(); // conversation ids whose read marks are held
  const pendingQuiet = new Set(); // being opened quietly, component not seen yet
  let allowRead = false;
  function dmConvId(dm) {
    const st = valueOf(get(dm, 'state'));
    return idOf(first(st, ['convId', 'conversationId']));
  }
  function addDm(dm, via) {
    for (const e of dms.values()) if (e.dm === dm) return;
    const conv = dmConvId(dm);
    if (!conv) return drop('conversation-component');
    patchDmProto(dm, via);
    learnFromComponent(dm, 'DmEvent');
    learnFromComponent(get(dm, 'composer'), 'ChatComposerEvent');
    const e = { dm, via, sub: null, timer: null, last: '' };
    dms.set(conv, e);
    pendingQuiet.delete(conv);
    try {
      e.sub = get(dm, 'state').subscribe(() => {
        clearTimeout(e.timer);
        e.timer = setTimeout(() => emitMessages(conv), 300);
      });
    } catch (err) {
      log('warn', 'could not follow a conversation');
    }
    emitMessages(conv);
  }
  function chatItems(dm) {
    const st = valueOf(get(dm, 'state'));
    const ci = get(st, 'chatItems');
    return { st, ci, items: arr(first(ci, ['items']) || ci) };
  }
  function emitMessages(conv) {
    const e = dms.get(conv);
    if (!e) return null;
    const { st, ci, items } = chatItems(e.dm);
    const messages = [];
    const other = {};
    for (const it of items.slice(-400)) {
      if (!isMessage(it)) {
        const n = kname(it) || 'plain';
        other[n] = (other[n] || 0) + 1;
        continue;
      }
      const m = itemRaw(it, conv);
      if (m) messages.push(m);
      else drop('message');
    }
    const raw = {
      conv,
      legacy: boolOf(get(st, 'isLegacy')),
      participants: arr(get(st, 'currentParticipantIds')).map(idOf).filter(Boolean),
      readOnly: !!get(st, 'readOnlyReason'),
      older: !!first(ci, ['olderItemsInfo']) || !!first(st, ['olderItemsInfo']),
      quiet: quiet.has(conv),
      messages,
      other,
    };
    const key = JSON.stringify(raw);
    if (key !== e.last) {
      e.last = key;
      post({ t: 'messages', ...raw });
    }
    return raw;
  }
  const isMessage = (it) => !!it && typeof it === 'object' && get(it, 'sequenceNumber') != null && ('textContent' in it || 'attachments' in it);
  function itemRaw(it, conv) {
    const id = idOf(get(it, 'id'));
    const seq = seqOf(get(it, 'sequenceNumber'));
    if (!id && !seq) return null;
    const sender = get(it, 'senderInfo');
    const senderUser = userRaw(sender) || usersIn(sender, 1)[0] || null;
    const reply = get(it, 'replyPreview');
    const info = get(it, 'messageInfo');
    const hidden = get(it, 'hiddenState');
    return {
      id: id || `seq:${seq}`,
      conv,
      kind: kname(it),
      seq,
      readSeq: seqOf(get(it, 'sequenceNumberForReadState')),
      ts: msOf(first(it, ['created', 'createdAt', 'timestamp'])),
      sender: (senderUser && senderUser.id) || idOf(first(sender, ['userId', 'senderId', 'id'])) || idOf(get(it, 'senderId')),
      senderUser,
      mine: boolOf(get(it, 'alignsToViewerSide')),
      text: strOf(get(it, 'textContent')) ?? strOf(get(it, 'fullText')),
      encrypted: boolOf(get(it, 'isEncrypted')),
      undecryptable: boolOf(get(it, 'isUndecryptable')),
      edited: boolOf(get(info, 'showEdited')) || arr(get(it, 'editHistory')).length > 0 || null,
      hidden: hidden != null && enumName(hidden) !== 'Visible' && enumName(hidden) !== 'NONE' && enumName(hidden) !== 'None' ? enumName(hidden) || 'hidden' : null,
      forwarded: get(it, 'forwardedMessage') ? true : null,
      replyTo: reply ? { seq: seqOf(get(reply, 'sequenceNumber')), id: idOf(first(reply, ['messageId', 'id'])) } : null,
      reactions: reactionsRaw(get(it, 'reactions')),
      attachments: attachmentsRaw(it),
    };
  }
  function reactionsRaw(list) {
    const out = [];
    for (const r of arr(list).slice(0, 40)) {
      const emoji = strOf(first(r, ['reaction', 'emoji', 'text'])) || strOf(get(get(r, 'reaction'), 'emoji'));
      if (!emoji) {
        drop('reaction');
        continue;
      }
      const users = arr(get(r, 'participants'))
        .map((p) => idOf(first(p, ['userId', 'id', 'userIdString'])) || idOf(p))
        .filter(Boolean)
        .slice(0, 100);
      out.push({ emoji, users, mine: !!get(r, 'isSelected'), attachmentId: idOf(get(r, 'attachmentId')) });
    }
    return out;
  }
  function attachmentsRaw(it) {
    const out = [];
    const list = arr(get(it, 'attachments'));
    if (!list.length && get(it, 'attachment')) list.push(get(it, 'attachment'));
    list.slice(0, 20).forEach((a, i) => {
      if (!a || typeof a !== 'object') return drop('attachment');
      const dim = get(a, 'dimensions') || get(a, 'dimension');
      out.push({
        index: i,
        id: idOf(first(a, ['attachmentId', 'mediaId', 'id', 'mediaHashKey'])),
        kind: kname(a),
        type: enumName(first(a, ['mediaType', 'type'])),
        mime: strOf(first(a, ['mimeType', 'contentType'])),
        name: strOf(first(a, ['originalFilename', 'filename'])),
        size: numOf(first(a, ['fileSize', 'size'])),
        width: numOf(first(dim, ['width', 'w'])),
        height: numOf(first(dim, ['height', 'h'])),
        url: urlOf(first(a, ['localOrRemoteUri', 'previewUrl', 'url', 'legacyMediaUrl', 'uri'])),
      });
    });
    return out;
  }

  /**
   * The DM component's onEvent, once per class: held read marks for quiet conversations, and the event classes
   * learned from the events the UI sends (a fallback for the module scan).
   */
  const patchedProtos = new WeakSet();
  function patchDmProto(dm) {
    let proto = Object.getPrototypeOf(dm);
    while (proto && proto !== Object.prototype && !Object.prototype.hasOwnProperty.call(proto, 'onEvent')) proto = Object.getPrototypeOf(proto);
    if (!proto || proto === Object.prototype || patchedProtos.has(proto)) return;
    const orig = proto.onEvent;
    if (!fn(orig)) return mark('quietReads', false, null);
    patchedProtos.add(proto);
    proto.onEvent = cloak.wrap(orig, (self, args) => {
      try {
        const ev = args[0];
        counts.events++;
        learnEvent(ev, 'DmEvent');
        if (!allowRead && isReadMark(ev)) {
          const conv = dmConvId(self);
          if (conv && (quiet.has(conv) || pendingQuiet.has(conv))) {
            counts.readsHeld++;
            return undefined;
          }
        }
      } catch (e) {}
      return cloak.apply(orig, self, args);
    });
    mark('quietReads', true, 'prototype');
  }
  const isReadMark = (ev) => {
    const n = kname(ev);
    return n === 'VisibleReadableItemsChanged' || (!n && ev && 'visibleReadableSequenceNumbers' in ev);
  };

  // --------------------------------------------------------- Kotlin classes
  // The sealed event classes, with their subclasses as statics (DmEvent.ScrolledToTop, ChatComposerEvent.UserChangedText,
  // ConversationListEvent.RowClicked), Kotlin's list, the reaction picker's item, and the message target with
  // Companion.forMessage.
  const K = {
    DmEvent: null,
    ChatComposerEvent: null,
    ConversationListEvent: null,
    KtList: null,
    ReactionPickerItem: null,
    MessageTarget: null,
    MessageRequestsEvent: null,
    NewDmEvent: null,
    AddGroupParticipantsEvent: null,
    EditGroupMetadataEvent: null,
    ForwardMessageEvent: null,
    ChatMessageAction: null,
    XConversationId: null,
    MessageRequestsCallbacks: null,
    AddGroupParticipantsCallbacks: null,
    EditGroupMetadataCallbacks: null,
  };
  const KVia = {};
  const SHAPES = {
    DmEvent: (f) => fn(f.ScrolledToTop) && fn(f.VisibleReadableItemsChanged),
    ChatComposerEvent: (f) => fn(f.UserChangedText) && fn(f.RightButtonClicked),
    ConversationListEvent: (f) => fn(f.RowClicked) && 'ScrolledToBottomOfConversations' in f,
    KtList: (f) => fn(f.fromJsArray),
    ReactionPickerItem: () => false,
    MessageTarget: (f) => !!f.Companion && fn(get(f.Companion, 'forMessage')),
    MessageRequestsEvent: (f) => fn(f.AcceptRequestClicked) && fn(f.BlockRequestClicked),
    NewDmEvent: (f) => fn(f.SuggestionClicked) && 'CreateButtonClicked' in f,
    AddGroupParticipantsEvent: (f) => fn(f.UserRowClicked) && 'DoneClicked' in f,
    EditGroupMetadataEvent: (f) => fn(f.TitleTextUpdated) && fn(f.DescriptionTextUpdated),
    ForwardMessageEvent: (f) => fn(f.SelectSuggestion) && 'SendButtonClicked' in f,
    ChatMessageAction: (f) => fn(f.Forward) && fn(f.DeleteForAll),
    XConversationId: (f) => fn(f.OneOnOne) && fn(f.Group) && !!f.Companion && fn(get(f.Companion, 'fromStringRequired')),
    MessageRequestsCallbacks: () => false,
    AddGroupParticipantsCallbacks: () => false,
    EditGroupMetadataCallbacks: () => false,
  };
  /** Kotlin's own names where they differ from ours: the list interface is `List`. */
  const ALIASES = { KtList: ['KtList', 'List'] };
  function offer(f, via) {
    if (!fn(f)) return;
    const n = kclassName(f);
    for (const k of Object.keys(K)) {
      if (K[k]) continue;
      let hit = (ALIASES[k] || [k]).includes(n);
      if (!hit) {
        try {
          hit = SHAPES[k](f);
        } catch (e) {}
        if (hit) via = via + '+shape';
      }
      if (hit) {
        K[k] = f;
        KVia[k] = via;
      }
    }
  }
  function learnEvent(ev, want) {
    if (K[want] || !ev || typeof ev !== 'object') return;
    try {
      let p = Object.getPrototypeOf(ev);
      for (let i = 0; p && p !== Object.prototype && i < 4; i++) {
        const c = p.constructor;
        if (kclassName(c) === want || (SHAPES[want] && SHAPES[want](c))) {
          K[want] = c;
          KVia[want] = 'events';
          classesChanged();
          return;
        }
        p = Object.getPrototypeOf(p);
      }
    } catch (e) {}
  }
  /** Wrap a component's onEvent prototype just to learn its event class from the UI's own events. */
  function learnFromComponent(c, want) {
    if (!c || typeof c !== 'object' || K[want]) return;
    let proto = Object.getPrototypeOf(c);
    while (proto && proto !== Object.prototype && !Object.prototype.hasOwnProperty.call(proto, 'onEvent')) proto = Object.getPrototypeOf(proto);
    if (!proto || proto === Object.prototype || patchedProtos.has(proto)) return;
    const orig = proto.onEvent;
    if (!fn(orig)) return;
    patchedProtos.add(proto);
    proto.onEvent = cloak.wrap(orig, (self, args) => {
      try {
        learnEvent(args[0], want);
      } catch (e) {}
      return cloak.apply(orig, self, args);
    });
  }

  // Module URLs the page loaded (resource timing, from document_start, with room for many entries).
  const chunkUrls = new Set();
  const scannedUrls = new Set();
  let coreUrl = null;
  let coreVia = null;
  try {
    performance.setResourceTimingBufferSize(5000);
  } catch (e) {}
  const noteUrl = (u) => {
    if (typeof u === 'string' && /\.m?js(\?|$)/.test(u)) chunkUrls.add(u);
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) noteUrl(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {
    try {
      for (const e of performance.getEntriesByType('resource')) noteUrl(e.name);
    } catch (err) {}
  }
  const fileOf = (u) => {
    try {
      return new URL(u).pathname.split('/').pop();
    } catch (e) {
      return '';
    }
  };
  /** The URL of the module that defines the graph's class: from the stack of one of its getters called on nothing. */
  function definingUrl(obj) {
    let proto = Object.getPrototypeOf(obj);
    for (let i = 0; proto && proto !== Object.prototype && i < 3; i++, proto = Object.getPrototypeOf(proto)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
        if (k === 'constructor' || !d.get) continue;
        try {
          d.get.call(null);
        } catch (e) {
          const m = String((e && e.stack) || '').match(/(https?:\/\/[^\s)'"]+?\.m?js)/);
          if (m) return m[1];
        }
      }
    }
    return null;
  }
  let findingClasses = null;
  function findClasses() {
    if (findingClasses) return findingClasses;
    findingClasses = (async () => {
      try {
        for (const e of performance.getEntriesByType('resource')) noteUrl(e.name);
      } catch (e) {}
      const byName = [...chunkUrls].filter((u) => /^dm-core[-.]/.test(fileOf(u)));
      let list = byName;
      coreVia = 'resources';
      if (!list.length && found.graph) {
        const u = definingUrl(found.graph);
        if (u) {
          list = [u];
          coreVia = 'stack';
        }
      }
      coreUrl = list[0] || null;
      for (const u of list) {
        if (scannedUrls.has(u)) continue;
        scannedUrls.add(u);
        let ns;
        try {
          ns = await import(u);
        } catch (e) {
          log('warn', `module ${fileOf(u)} would not import again`);
          continue;
        }
        counts.modulesScanned++;
        for (const k of Object.keys(ns)) {
          let v;
          try {
            v = ns[k];
          } catch (e) {
            continue;
          }
          offer(v, 'module');
        }
      }
      classesChanged();
    })().finally(() => {
      findingClasses = null;
    });
    return findingClasses;
  }
  function classesChanged() {
    const D = K.DmEvent;
    const C = K.ChatComposerEvent;
    const L = K.ConversationListEvent;
    const via = (k) => KVia[k] || 'module';
    mark('classes', !!(D || C), D ? via('DmEvent') : C ? via('ChatComposerEvent') : null);
    mark('open', !!(L && fn(L.RowClicked)) || true, L && fn(L.RowClicked) ? `event:${via('ConversationListEvent')}` : 'navigate');
    mark('history', !!(D && fn(D.ScrolledToTop)), 'event');
    mark('read', !!(D && fn(D.VisibleReadableItemsChanged) && K.KtList), 'event');
    mark('send', !!(C && fn(C.UserChangedText) && fn(C.RightButtonClicked)), 'event');
    mark('reply', !!((C && fn(C.StartReplyingToMessage)) || (D && fn(D.ReplyToMessageClicked))), C && fn(C.StartReplyingToMessage) ? 'composer' : 'dm');
    mark('edit', !!(C && fn(C.StartEditingMessage) && fn(C.UserChangedText)), 'composer');
    mark('unsend', !!(D && fn(D.DeleteMessageForAll) && K.MessageTarget), 'event');
    mark('reactions', !!(D && fn(D.ReactionPickerItemClick) && K.ReactionPickerItem), 'event');
    gapsChanged();
    inboxSoon();
  }

  // --------------------------------------------------------------- who it is
  function findSelf() {
    let id = null;
    let via = null;
    const g = found.graph;
    if (g) {
      // The graph is made with the signed-in user's id: a field holding a Kotlin user id.
      for (const k of Object.keys(g)) {
        const v = get(g, k);
        if (v && typeof v === 'object' && typeof get(v, 'userIdString') === 'string') {
          id = get(v, 'userIdString');
          via = 'graph';
          break;
        }
      }
    }
    if (!id) {
      // x.com's own user cookie (not a secret: `u=<user id>`), which the page reads too.
      const m = /(?:^|;\s*)twid=(?:u%3D|u=)(\d+)/.exec(document.cookie || '');
      if (m) {
        id = m[1];
        via = 'cookie';
      }
    }
    mark('self', !!id, via);
    if (id && id !== selfId) {
      selfId = id;
      post({ t: 'self', id });
      if (!hooks.openDirect.ok) gapsChanged();
    }
  }
  let selfId = null;

  // -------------------------------------------------------------- the page
  let lastPage = '';
  function pageState() {
    const p = location.pathname;
    if (/^\/(i\/flow\/login|i\/flow\/signup|login|signup|i\/jf\/onboarding)(\/|$)/.test(p)) return 'login';
    if (/^\/(account\/access|account\/login_challenge|i\/flow\/)/.test(p)) return 'verify';
    if (/^\/i\/chat\/pin(\/|$)/.test(p) || pinOnScreen(p)) return 'pin';
    if (/^\/(i\/chat|messages)(\/|$)/.test(p)) return 'chat';
    for (const u of chunkUrls) if (/entry-client-logged-out/.test(u)) return 'login';
    return 'other';
  }
  /** The PIN screen in the embed's shadow roots (its test ids), for a PIN asked for away from its own path. */
  let pinCheckedAt = 0;
  let pinSeen = false;
  function pinOnScreen(path) {
    // Only where it could be (the chat page with no inbox showing), and at most every 10 s.
    if (!/^\/(i\/chat|messages)(\/|$)/.test(path) || found.list || pinComponent) return !!pinComponent;
    if (Date.now() - pinCheckedAt < 10_000) return pinSeen;
    pinCheckedAt = Date.now();
    pinSeen = pinDom();
    return pinSeen;
  }
  function pinDom() {
    try {
      const hosts = document.querySelectorAll('*');
      for (let i = 0; i < hosts.length && i < 20000; i++) {
        const sr = hosts[i].shadowRoot;
        if (sr && sr.querySelector('[data-testid="pin-code-input-container"],[data-testid="pin-title"]')) return true;
      }
    } catch (e) {}
    return false;
  }
  function pageCheck() {
    const state = pageState();
    const mode = state === 'pin' ? (location.pathname.split('/')[4] || null) : null;
    const key = `${state}|${location.pathname}|${mode}`;
    if (key === lastPage) return;
    lastPage = key;
    post({ t: 'page', state, path: location.pathname, pinMode: mode, pinComponent: !!pinComponent });
  }

  // ---------------------------------------------------------------- commands
  const need = (k) => {
    if (!K[k]) throw new Error(`X changed: ${k} was not found, so this cannot be done the client's way`);
    return K[k];
  };
  function waitFor(f, ms, what) {
    return new Promise((resolve, reject) => {
      const end = Date.now() + ms;
      const tick = () => {
        let v = null;
        try {
          v = f();
        } catch (e) {}
        if (v) return resolve(v);
        if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
        setTimeout(tick, 120);
      };
      tick();
    });
  }
  /** One command at a time: the UI has one open conversation. */
  let chain = Promise.resolve();
  const serial = (f) => {
    const p = chain.then(f, f);
    chain = p.catch(() => {});
    return p;
  };

  let openedByUs = null;
  let closeTimer = null;
  /** Make `conv` the open conversation (quietly unless asked), run `f(dm)`, and close it again a little later. */
  async function withConversation(conv, f, opts) {
    opts = opts || {};
    clearTimeout(closeTimer);
    let e = dms.get(conv);
    if (!e) {
      if (opts.quiet !== false) {
        quiet.add(conv);
        pendingQuiet.add(conv);
      }
      if (openedByUs && openedByUs !== conv) await closeConversation(openedByUs);
      const how = await openConversation(conv);
      openedByUs = conv;
      const opened = () => {
        scan();
        return dms.get(conv);
      };
      e = await waitFor(opened, how === 'event' ? 6000 : 20_000, 'the conversation to open').catch(async (err) => {
        if (how !== 'event') throw err;
        // The row's event did not open it (another preview type, a changed callback): the address, as a link would.
        log('info', 'opening by its row did not work; opening by its address');
        mark('open', true, 'navigate');
        navigate(convPath(conv));
        return waitFor(opened, 20_000, 'the conversation to open');
      });
      await waitFor(() => chatItems(e.dm).st && get(chatItems(e.dm).st, 'chatItems'), 15_000, 'its messages to load').catch(() => null);
      await sleep(human(400, 900));
    }
    try {
      return await f(e.dm);
    } finally {
      if (openedByUs === conv) closeTimer = setTimeout(() => void serial(() => closeConversation(conv)), opts.keepMs || 8000);
    }
  }
  async function openConversation(conv) {
    const L = K.ConversationListEvent;
    const p = previewObjects.get(conv);
    if (L && fn(L.RowClicked) && p && found.list && hooks.open.via !== 'navigate') {
      try {
        get(found.list, 'onEvent').call(found.list, new L.RowClicked(p));
        return 'event';
      } catch (e) {
        log('warn', 'the row event threw; opening by address');
      }
    }
    navigate(convPath(conv));
    return 'navigate';
  }
  /** A conversation's address as the client's toConversation makes it; a message request's is under /requests. */
  const convPath = (conv) => `${chatBase()}${isRequest(conv) ? '/requests' : ''}/${encodeURIComponent(pathId(conv))}`;
  async function closeConversation(conv) {
    const e = dms.get(conv);
    if (openedByUs === conv) openedByUs = null;
    if (e) {
      const D = K.DmEvent;
      let back = null;
      try {
        back = D && get(D, 'BackButtonClicked');
      } catch (err) {}
      if (back && typeof back === 'object') get(e.dm, 'onEvent').call(e.dm, back);
      else navigate(chatBase());
      await waitFor(() => {
        scan();
        return !dms.has(conv);
      }, 4000, 'the conversation to close').catch(() => {
        navigate(chatBase());
      });
    }
    quiet.delete(conv);
    pendingQuiet.delete(conv);
  }
  /** The chat's base path: /i/chat on x.com (the embed is told it by the host). */
  const chatBase = () => (/^\/messages(\/|$)/.test(location.pathname) ? '/messages' : '/i/chat');
  /** As the app's router would: a history entry and the popstate it listens for. */
  function navigate(path) {
    try {
      history.pushState(history.state, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch (e) {}
  }

  function itemsOf(dm) {
    return chatItems(dm).items.filter(isMessage);
  }
  function findItem(dm, conv, id) {
    for (const it of itemsOf(dm)) {
      const r = idOf(get(it, 'id')) || `seq:${seqOf(get(it, 'sequenceNumber'))}`;
      if (r === id) return it;
    }
    return null;
  }
  const composerOf = (dm) => get(dm, 'composer');
  const composerState = (dm) => valueOf(get(composerOf(dm), 'state'));
  const onEvent = (c, ev) => get(c, 'onEvent').call(c, ev);

  async function typeAndSend(dm, text) {
    const C = need('ChatComposerEvent');
    const comp = composerOf(dm);
    if (!comp) throw new Error('the conversation has no composer (read-only here)');
    onEvent(comp, new C.UserChangedText(text, text.length));
    await sleep(human(250, 700));
    const st = await waitFor(() => {
      const s = composerState(dm);
      return s && enumName(get(s, 'rightButton')) === 'SendActive' ? s : null;
    }, 6000, 'the send button').catch(() => {
      const s = composerState(dm);
      throw new Error(`the composer did not offer to send (${enumName(get(s, 'rightButton')) || 'no button'})`);
    });
    onEvent(comp, new C.RightButtonClicked(get(st, 'rightButton')));
  }
  function newMine(dm, before, text) {
    for (const it of itemsOf(dm)) {
      const id = idOf(get(it, 'id')) || `seq:${seqOf(get(it, 'sequenceNumber'))}`;
      if (before.has(id)) continue;
      if (get(it, 'alignsToViewerSide') === false) continue;
      if (text != null && strOf(get(it, 'textContent')) !== text && strOf(get(it, 'fullText')) !== text) continue;
      return id;
    }
    return null;
  }
  const idsNow = (dm) => new Set(itemsOf(dm).map((it) => idOf(get(it, 'id')) || `seq:${seqOf(get(it, 'sequenceNumber'))}`));

  async function cmdSend(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const before = idsNow(dm);
      if (cmd.replyTo) await startReply(dm, cmd.conv, cmd.replyTo);
      if (cmd.files && cmd.files.length) await attachFiles(dm, cmd.files);
      if (cmd.text || !(cmd.files && cmd.files.length)) await typeAndSend(dm, cmd.text || '');
      else await pressSend(dm);
      const id = await waitFor(() => newMine(dm, before, cmd.files && cmd.files.length ? null : cmd.text), 30_000, 'the sent message').catch(() => null);
      return { nativeId: id };
    }, { quiet: true });
  }
  async function pressSend(dm) {
    const C = need('ChatComposerEvent');
    const st = await waitFor(() => {
      const s = composerState(dm);
      return s && enumName(get(s, 'rightButton')) === 'SendActive' ? s : null;
    }, 60_000, 'the attachment to be ready');
    onEvent(composerOf(dm), new C.RightButtonClicked(get(st, 'rightButton')));
  }
  async function startReply(dm, conv, replyTo) {
    const item = findItem(dm, conv, replyTo);
    if (!item) throw new Error('the message to reply to is not loaded in this conversation');
    const C = K.ChatComposerEvent;
    const D = K.DmEvent;
    if (C && fn(C.StartReplyingToMessage)) onEvent(composerOf(dm), new C.StartReplyingToMessage(item, null));
    else if (D && fn(D.ReplyToMessageClicked)) onEvent(dm, new D.ReplyToMessageClicked(item));
    else throw new Error('X changed: replying was not found');
    await waitFor(() => get(composerState(dm), 'replyingTo'), 4000, 'the reply bar').catch(() => {
      throw new Error('the composer did not take the reply');
    });
    await sleep(human(200, 500));
  }
  /** Files go in through the composer's own file input, as when you pick them: the UI attaches and uploads them. */
  async function attachFiles(dm, files) {
    const input = composerFileInput();
    mark('attach', !!input, 'input');
    if (!input) throw new Error('X changed: the composer has no file input');
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.mime }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => arr(get(composerState(dm), 'attachments')).length >= files.length, 15_000, 'the attachments to be taken');
  }
  function composerFileInput() {
    const sel = '[data-testid="dm-composer-file-input"],input[type="file"][data-testid*="composer"]';
    let input = null;
    const visit = (root, depth) => {
      if (input || depth > 6) return;
      try {
        input = root.querySelector(sel);
        if (input) return;
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      } catch (e) {}
    };
    visit(document, 0);
    return input;
  }

  function actionsFor(dm, item) {
    const T = need('MessageTarget');
    const targets = arr(T.Companion.forMessage(item));
    const target = targets.find((t) => !get(t, 'fromAttachment')) || targets[0];
    if (!target) throw new Error('X offers no actions on this message');
    return get(dm, 'messageActions').call(dm, item, target);
  }
  async function cmdEdit(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const item = findItem(dm, cmd.conv, cmd.message);
      if (!item) throw new Error('the message is not loaded in this conversation');
      const C = need('ChatComposerEvent');
      if (!fn(C.StartEditingMessage)) throw new Error('X changed: editing was not found');
      try {
        const acts = actionsFor(dm, item);
        if (acts && get(acts, 'canEdit') === false) throw new Error('X does not offer to edit this message');
      } catch (e) {
        if (/does not offer/.test(e.message)) throw e;
      }
      onEvent(composerOf(dm), new C.StartEditingMessage(item));
      await waitFor(() => get(composerState(dm), 'isEditing'), 4000, 'the edit mode').catch(() => {
        throw new Error('the composer did not start editing');
      });
      await sleep(human(200, 500));
      await typeAndSend(dm, cmd.text);
      await waitFor(() => {
        const it = findItem(dm, cmd.conv, cmd.message);
        return it && strOf(get(it, 'textContent')) === cmd.text;
      }, 20_000, 'the edit to show').catch(() => null);
      return { ok: true };
    });
  }
  async function cmdUnsend(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const item = findItem(dm, cmd.conv, cmd.message);
      if (!item) throw new Error('the message is not loaded in this conversation');
      const D = need('DmEvent');
      const acts = actionsFor(dm, item);
      const offered = arr(get(acts, 'overflow')).find((a) => kname(a) === 'DeleteForAll');
      const del = (acts && get(acts, 'deletableMessage')) || offered;
      if (!del) throw new Error('X does not offer to delete this message for everyone');
      onEvent(dm, new D.DeleteMessageForAll(get(del, 'message') || item));
      await waitFor(() => !findItem(dm, cmd.conv, cmd.message) || get(findItem(dm, cmd.conv, cmd.message), 'hiddenState'), 20_000, 'the message to go').catch(() => null);
      return { ok: true };
    });
  }
  async function cmdReact(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const item = findItem(dm, cmd.conv, cmd.message);
      if (!item) throw new Error('the message is not loaded in this conversation');
      const D = need('DmEvent');
      const P = need('ReactionPickerItem');
      const mine = reactionsRaw(get(item, 'reactions')).some((r) => r.emoji === cmd.emoji && r.mine);
      if (!!cmd.remove !== mine) return { ok: true, unchanged: true };
      onEvent(dm, new D.ReactionPickerItemClick(new P(cmd.emoji, mine), item, null));
      await waitFor(() => {
        const it = findItem(dm, cmd.conv, cmd.message);
        return it && reactionsRaw(get(it, 'reactions')).some((r) => r.emoji === cmd.emoji && r.mine) === !cmd.remove;
      }, 15_000, 'the reaction to show').catch(() => null);
      return { ok: true };
    });
  }
  async function cmdMarkRead(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const D = need('DmEvent');
      const L = need('KtList');
      const items = itemsOf(dm);
      let upto = items.length - 1;
      if (cmd.message) {
        const i = items.findIndex((it) => (idOf(get(it, 'id')) || `seq:${seqOf(get(it, 'sequenceNumber'))}`) === cmd.message);
        if (i >= 0) upto = i;
      }
      const seqs = items
        .slice(0, upto + 1)
        .map((it) => get(it, 'sequenceNumberForReadState'))
        .filter((s) => s != null);
      if (!seqs.length) return { ok: true, nothing: true };
      allowRead = true;
      try {
        onEvent(dm, new D.VisibleReadableItemsChanged(upto === items.length - 1, L.fromJsArray(seqs.slice(-50))));
      } finally {
        allowRead = false;
      }
      counts.readsSent++;
      return { ok: true };
    });
  }
  async function cmdHistory(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const D = K.DmEvent;
      const want = Math.min(Math.max(cmd.limit || 50, 1), 500);
      const beforeMs = cmd.beforeTs || Infinity;
      let rounds = 0;
      for (; rounds < 12; rounds++) {
        const items = itemsOf(dm);
        const older = items.filter((it) => (msOf(first(it, ['created', 'createdAt'])) || 0) < beforeMs).length;
        const { st, ci } = chatItems(dm);
        const info = first(ci, ['olderItemsInfo']) || first(st, ['olderItemsInfo']);
        if (older >= want || !info || !D || !fn(D.ScrolledToTop)) break;
        const n = items.length;
        onEvent(dm, new D.ScrolledToTop(info));
        await waitFor(() => itemsOf(dm).length > n || !(first(chatItems(dm).ci, ['olderItemsInfo']) || first(chatItems(dm).st, ['olderItemsInfo'])), 15_000, 'older messages').catch(() => null);
        await sleep(human(700, 1600));
      }
      const raw = emitMessages(cmd.conv);
      return { count: raw ? raw.messages.length : 0, more: !!(raw && raw.older), rounds };
    });
  }
  /** A media file the page shows: a blob it already has, or a twimg URL fetched with its cookies, as an <img> would. */
  async function cmdMedia(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const item = findItem(dm, cmd.conv, cmd.message);
      if (!item) throw new Error('the message is not loaded in this conversation');
      let a = attachmentsRaw(item)[cmd.index || 0];
      if (!a) throw new Error('no such attachment');
      if (!a.url) {
        const D = K.DmEvent;
        for (const name of ['ResolveMediaImmediately', 'ResolveMediaIfNeeded']) {
          if (D && fn(D[name])) {
            try {
              onEvent(dm, new D[name](item));
            } catch (e) {}
            break;
          }
        }
        a = await waitFor(() => {
          const it = findItem(dm, cmd.conv, cmd.message);
          const x = it && attachmentsRaw(it)[cmd.index || 0];
          return x && x.url ? x : null;
        }, 20_000, 'the media to load');
      }
      const u = a.url;
      const local = /^(blob:|data:)/.test(u);
      let host = '';
      try {
        host = new URL(u).hostname;
      } catch (e) {}
      if (!local && !/(^|\.)twimg\.com$|(^|\.)x\.com$/.test(host) && !(settings.testOrigin && u.startsWith(settings.testOrigin))) throw new Error('refusing media from outside X');
      const res = await fetch(u, local ? {} : { credentials: 'include' });
      if (!res.ok) throw new Error(`media answered ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error('media too large');
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { mime: res.headers.get('content-type') || a.mime || 'application/octet-stream', base64: btoa(bin) };
    });
  }

  // ------------------------------------------------------- requests, new chats, groups, typing, forwarding
  // What X's chat offers past reading and writing in a conversation, each the way its own screens do it: the
  // Requests page's component (message requests, and Accept / Delete / Block on them), New message (open a
  // one-to-one, or Create a group), a group's Add people and Edit Group screens, the composer's typing, and a
  // message's Forward action with its dialog. Components the UI makes for a screen are made here with the graph's or
  // the conversation container's own factory, with a Cancellation the core's subscribe takes, and dropped after.
  // docs/x.md has which events and what is unverified.

  /** A component's events go to `onEvent` (lists, New message) or `handleEvent` (Add people, Edit Group, forwarding). */
  function fire(c, ev) {
    const f = get(c, 'onEvent') || get(c, 'handleEvent');
    if (!fn(f)) throw new Error('X changed: that screen takes no events');
    return f.call(c, ev);
  }
  const stateOf = (c) => valueOf(get(c, 'state'));
  /** Objects handed to the core (callbacks, a Cancellation) are plain objects, as the embed's are plain classes. */
  const plain = (o) => o;
  /** The Cancellation a component factory takes: the core subscribes its teardown to it. */
  function cancellation() {
    let cbs = [];
    return plain({
      subscribe(cb) {
        if (fn(cb)) cbs.push(cb);
      },
      cancel() {
        const run = cbs;
        cbs = [];
        for (const cb of run) {
          try {
            cb();
          } catch (e) {}
        }
      },
    });
  }
  /** A path segment for a conversation id, as the client writes it (`toConversation`: ':' as '-'). */
  const pathId = (id) => String(id).split(':').join('-');
  /** The client's own id object for a conversation: from its inbox or Requests row, else parsed as the client parses a route. */
  function convIdObj(conv) {
    for (const m of [previewObjects, requestPreviews]) {
      const p = m.get(conv);
      const v = p && (get(p, 'conversationId') || get(get(p, 'preview'), 'conversationId'));
      if (v) return v;
    }
    const X = K.XConversationId;
    const c = X && get(X, 'Companion');
    if (c && fn(get(c, 'fromStringRequired'))) return get(c, 'fromStringRequired').call(c, conv);
    throw new Error('X changed: a conversation id could not be made the client\'s way');
  }
  /** A conversation row's ConversationMetadata: the row's own, or (as X has it) inside its key data. */
  function metaOf(p) {
    const md = get(p, 'metadata');
    return md && !get(md, 'attributes') && get(md, 'metadata') ? get(md, 'metadata') : md;
  }
  /** A user id from a suggestion or a user, however the client holds it. */
  const userIdOf = (u) => idOf(first(u, ['id', 'userId', 'userIdString']));
  const suggestionUser = (s) => get(s, 'user') || s;
  /** A reason enum ("NotFollowing") in words: `X does not let you message them (not following)`. */
  const reasonOf = (r) => {
    const n = enumName(r) || (r && kname(r));
    return n ? ` (${n.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()})` : '';
  };
  /** A toast a component shows (its `toasts` flow), followed while it is in use. */
  function followToasts(c) {
    const box = { last: null, sub: null };
    const t = get(c, 'toasts');
    if (isFlow(t)) {
      try {
        box.sub = t.subscribe((v) => {
          if (v != null && !(fn(get(v, 'asJsReadonlyArrayView')) && !arr(v).length)) box.last = enumName(v) || kname(v) || 'toast';
        });
      } catch (e) {}
    }
    box.stop = () => {
      try {
        box.sub && box.sub.cancel();
      } catch (e) {}
    };
    return box;
  }
  /** Type a query into a screen's search (its QueryChanged, as pasting it) and wait for that person among the suggestions. */
  async function searchFor(comp, E, query, who, listKey) {
    fire(comp, new E.QueryChanged(query));
    const q = String(query).replace(/^@/, '').toLowerCase();
    const is = (s) => {
      const u = suggestionUser(s);
      return who ? userIdOf(u) === who : String(get(u, 'screenName') || '').toLowerCase() === q;
    };
    return waitFor(() => arr(get(stateOf(comp), listKey || 'suggestions')).find(is), 12_000, 'X\'s search').catch(() => {
      throw new Error("X's search did not find them");
    });
  }

  // --------------------------------------------------------------- requests
  const requestPreviews = new Map(); // conversation id -> its Requests row
  let requestsComp = null;
  let requestsCancel = null;
  let requestsSub = null;
  let requestsTimer = null;
  let requestsKey = null;
  let requestsMoreAt = 0;
  /** What the inbox says of requests (its Requests row, or the button): how many, and whether you have looked. */
  function requestsSignal(st) {
    for (const it of arr(get(st, 'previewItems'))) {
      const r = get(it, 'messageRequests');
      if (r && typeof r === 'object') return { known: true, count: numOf(get(r, 'priorityCount')) || 0, key: `${numOf(get(r, 'priorityCount'))}|${boolOf(get(r, 'isUnseen'))}|${arr(get(r, 'relevantUserNames')).length}` };
    }
    const b = get(st, 'messageRequestsButton');
    if (b && typeof b === 'object') return { known: true, count: numOf(get(b, 'count')) || 0, key: `b${numOf(get(b, 'count'))}` };
    // A list that has loaded and has no Requests row: none waiting.
    if (arr(get(st, 'previewItems')).length && hasField(st, 'messageRequestsButton')) return { known: true, count: 0, key: '0' };
    return { known: false, count: 0, key: null };
  }
  const hasField = (o, k) => {
    try {
      return k in o;
    } catch (e) {
      return false;
    }
  };
  /**
   * After each inbox state: when its Requests row changes (or the account starts), look at the requests. Nothing
   * waiting is said without opening anything; something waiting opens the Requests page's component, which X's
   * client then marks seen for this account (the dot on the Requests row; nothing goes to the sender).
   */
  function requestsCheck(st) {
    if (!hooks.requests.ok || !hooks.answer.ok) return;
    const sig = requestsSignal(st);
    if (sig.known && sig.key === requestsKey) return;
    if (!sig.known && requestsKey === 'unknown') return;
    requestsKey = sig.known ? sig.key : 'unknown';
    if (sig.known && sig.count === 0 && !requestsComp) {
      requestPreviews.clear();
      post({ t: 'requests', requests: [], loading: false, more: false });
      return;
    }
    void lookAtRequests().catch((e) => log('info', `requests: ${String((e && e.message) || e).slice(0, 120)}`));
  }
  /** The Requests page's component: made with the graph's own factory and kept, or (fallback) the page's own. */
  async function lookAtRequests() {
    const g = found.graph;
    if (requestsComp) return emitRequests(true);
    if (g && fn(get(g, 'messageRequestsComponent'))) {
      requestsCancel = cancellation();
      const callbacks = plain({
        onConversationCtaActivated() {},
        onLinkClicked() {},
        onOtherClicked() {},
      });
      markInterface(callbacks, 'MessageRequestsCallbacks');
      requestsComp = get(g, 'messageRequestsComponent').call(g, callbacks, requestsCancel, false);
      followRequests();
      return emitRequests(true);
    }
    // The page's own: opened as its Requests row is, read, and the inbox shown again.
    return serial(() => onRequestsPage(async () => emitRequests(true)));
  }
  /** On the Requests page (the fallback): its own component while it is shown, then the inbox again. Not serial itself. */
  async function onRequestsPage(f) {
    found.requestsUi = null;
    navigate(`${chatBase()}/requests`);
    try {
      const c = await waitFor(() => (scan(), found.requestsUi), 15_000, 'the Requests page');
      await waitFor(() => !get(stateOf(c), 'isLoading'), 15_000, 'the requests to load').catch(() => null);
      return await f(c);
    } finally {
      navigate(chatBase());
      found.requestsUi = null;
    }
  }
  function followRequests() {
    try {
      requestsSub = get(requestsComp, 'state').subscribe(() => {
        clearTimeout(requestsTimer);
        requestsTimer = setTimeout(() => emitRequests(false), 400);
      });
    } catch (e) {
      log('warn', 'could not follow the requests');
    }
  }
  let lastRequests = '';
  function emitRequests(force) {
    const c = requestsComp || found.requestsUi;
    if (!c) return null;
    const raw = requestsRaw(c);
    if (raw.loading) return raw;
    const key = JSON.stringify(raw);
    if (key !== lastRequests || force) {
      lastRequests = key;
      post({ t: 'requests', ...raw });
    }
    // Like scrolling the list: a page at a time, up to 50.
    const R = K.MessageRequestsEvent;
    if (raw.more && raw.requests.length < 50 && R && Date.now() - requestsMoreAt > human(3000, 6000)) {
      requestsMoreAt = Date.now();
      try {
        fire(c, get(R, 'ScrolledToBottom'));
      } catch (e) {}
    }
    return raw;
  }
  function requestsRaw(c) {
    const st = stateOf(c);
    const requests = [];
    requestPreviews.clear();
    for (const p of arr(get(st, 'previews')).slice(0, 100)) {
      const conv = convRaw(p, true);
      if (!conv) {
        drop('request');
        continue;
      }
      requestPreviews.set(conv.id, p);
      requests.push(conv);
    }
    return { requests, loading: !!get(st, 'isLoading'), more: !!get(st, 'hasMoreItemsInfo'), failed: !!get(st, 'didFetchFail') };
  }
  /** Set a Kotlin interface's marker on an object the core may check with `is` (the embed's callback classes carry it). */
  function markInterface(o, name) {
    const I = K[name];
    try {
      if (I && typeof I.Symbol === 'string') o[I.Symbol] = true;
    } catch (e) {}
  }
  const isRequest = (conv) => requestPreviews.has(conv);

  /**
   * Answer a request, as its buttons do: on the Requests page Accept, or Delete / Block and their confirmation
   * dialogs; X's list answers one-to-one requests only, so a group's (and the fallback) is the conversation's own bar:
   * Accept, or Decline / Block and then their confirmations. Waits for it to leave the requests.
   */
  async function cmdAnswer(cmd) {
    if (requestsComp) emitRequests(true);
    if (!isRequest(cmd.conv)) throw new Error('That request is not waiting any more');
    const cid = convIdObj(cmd.conv);
    const group = groupOf(cid, cmd.conv) === true;
    const R = K.MessageRequestsEvent;
    if (R && !group) {
      const via = requestsComp ? 'list' : 'page';
      if (requestsComp) await answerInList(requestsComp, R, cid, cmd);
      else await onRequestsPage((c) => answerInList(c, R, cid, cmd));
      requestPreviews.delete(cmd.conv);
      if (requestsComp) emitRequests(true);
      return { ok: true, via, group };
    }
    return answerInConversation(cmd, group);
  }
  /** On the Requests list: Accept, or Delete / Block and the dialog's confirmation; then wait for it to leave the list. */
  async function answerInList(comp, R, cid, cmd) {
    const gone = () => !arr(get(stateOf(comp), 'previews')).some((x) => idOf(first(x, ['conversationId'])) === cmd.conv || idOf(get(get(x, 'preview'), 'conversationId')) === cmd.conv);
    if (gone()) throw new Error('That request is not waiting any more');
    if (cmd.answer === 'accept') fire(comp, new R.AcceptRequestClicked(cid));
    else {
      fire(comp, cmd.answer === 'block' ? new R.BlockRequestClicked(cid) : new R.DeleteRequestClicked(cid));
      const key = cmd.answer === 'block' ? 'confirmBlockConvId' : 'confirmDeleteConvId';
      await waitFor(() => get(stateOf(comp), key), 4000, 'the confirmation').catch(() => {
        throw new Error('X did not ask to confirm that');
      });
      await sleep(human(300, 700));
      fire(comp, get(R, cmd.answer === 'block' ? 'ConfirmBlock' : 'ConfirmDelete'));
    }
    const ok = await waitFor(gone, 20_000, 'the request to go').catch(() => null);
    if (!ok) throw new Error('X did not take the answer (the request is still there)');
  }
  /** In the conversation (a group's request, or without the list's events): its bar's Accept, or Decline / Block and confirm. */
  async function answerInConversation(cmd, group) {
    const D = need('DmEvent');
    if (group && cmd.answer !== 'accept') throw new Error('X answers a group request only with Accept');
    await withConversation(cmd.conv, async (dm) => {
      const step = cmd.answer === 'accept' ? 'AcceptMessageRequest' : cmd.answer === 'block' ? 'BlockMessageRequest' : 'DeclineMessageRequest';
      const ev = get(D, step);
      if (!ev || typeof ev !== 'object') throw new Error(`X changed: ${step} was not found`);
      fire(dm, ev);
      if (cmd.answer !== 'accept') {
        await sleep(human(300, 700));
        const confirm = get(D, cmd.answer === 'block' ? 'ConfirmBlockMessageRequest' : 'ConfirmDeclineMessageRequest');
        if (!confirm || typeof confirm !== 'object') throw new Error('X changed: the confirmation was not found');
        fire(dm, confirm);
      }
      await waitFor(() => {
        scan();
        const st = valueOf(get(dm, 'state'));
        const trust = enumName(get(get(st, 'messageRequest'), 'trustState'));
        return !dms.has(cmd.conv) || (cmd.answer === 'accept' && trust && trust !== 'RequestReceived');
      }, 20_000, 'X to take the answer').catch(() => {
        throw new Error('X did not take the answer');
      });
    });
    requestPreviews.delete(cmd.conv);
    if (requestsComp) emitRequests(true);
    return { ok: true, via: 'dm', group };
  }

  // --------------------------------------------------------------- New message: a one-to-one, a group
  /** New message's component, made as the dialog makes it, with the callbacks for going back and opening a conversation. */
  async function withNewDm(f) {
    const g = found.graph;
    const N = K.NewDmEvent;
    if (!g || !fn(get(g, 'newDmComponent')) || !N) throw new Error('X changed: New message was not found');
    const c = cancellation();
    const opened = { value: null };
    const comp = get(g, 'newDmComponent').call(g, c, undefined, undefined, () => {}, (cid) => {
      opened.value = cid;
    });
    const toasts = followToasts(comp);
    try {
      return await f(comp, N, opened, toasts);
    } finally {
      toasts.stop();
      c.cancel();
    }
  }
  /** The one-to-one with someone: picked in New message's search, which opens it (nothing is made until the first message). */
  async function cmdOpenDirect(cmd) {
    if (hooks.openDirect.via === 'id' || !cmd.handle) {
      if (!selfId) throw new Error('who this account is is not known yet');
      if (!cmd.peer) throw new Error('X needs their user id or handle');
      return { conv: oneOnOneId(selfId, cmd.peer), via: 'id' };
    }
    return withNewDm(async (comp, N, opened) => {
      const s = await searchFor(comp, N, cmd.handle, cmd.peer);
      const user = suggestionUser(s);
      if (get(user, 'canSendMessage') === false) throw new Error(`X does not let you message them${reasonOf(get(user, 'cannotMessageReason'))}`);
      await sleep(human(200, 500));
      fire(comp, new N.SuggestionClicked(s));
      const cid = await waitFor(() => opened.value, 10_000, 'the conversation to open');
      return { conv: idOf(cid), peer: userIdOf(user), via: 'search' };
    });
  }
  /** XChat's one-to-one id: the two user ids, the lower first (its XConversationId rule). */
  function oneOnOneId(a, b) {
    try {
      return BigInt(a) <= BigInt(b) ? `${a}:${b}` : `${b}:${a}`;
    } catch (e) {
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    }
  }
  const selectedIds = (st, key) => {
    const out = new Set();
    for (const [k, v] of entries(get(st, key))) {
      const a = idOf(k) || userIdOf(v);
      if (a) out.add(a);
    }
    return out;
  };
  /** Create a group, as New message → Create a group: each person from its search, then Create; a name after, on Edit Group. */
  async function cmdCreateGroup(cmd) {
    const made = await withNewDm(async (comp, N, opened, toasts) => {
      fire(comp, get(N, 'CreateAGroupItemClicked'));
      await waitFor(() => get(stateOf(comp), 'isCreateGroupMode'), 4000, 'Create a group');
      const added = [];
      const failed = [];
      for (const p of cmd.people) {
        await sleep(human(400, 900));
        let s;
        try {
          s = await searchFor(comp, N, p.handle, p.id);
        } catch (e) {
          failed.push({ id: p.id, reason: e.message });
          continue;
        }
        const user = suggestionUser(s);
        if (get(user, 'canBeAddedToGroup') === false) {
          failed.push({ id: p.id, reason: `X does not let you add them to a group${reasonOf(get(user, 'cannotBeAddedToGroupReason'))}` });
          continue;
        }
        fire(comp, new N.SuggestionClicked(s));
        const ok = await waitFor(() => selectedIds(stateOf(comp), 'selectedGroupUsers').has(p.id), 4000, 'them to be picked').catch(() => null);
        if (ok) added.push(p.id);
        else failed.push({ id: p.id, reason: 'X did not pick them' });
      }
      if (!added.length) throw new Error(failed.length ? `X would not put anyone in it: ${failed[0].reason}` : 'Nobody to put in the group');
      await sleep(human(400, 900));
      toasts.last = null;
      fire(comp, get(N, 'CreateButtonClicked'));
      const cid = await waitFor(() => {
        if (opened.value) return opened.value;
        if (toasts.last && !get(stateOf(comp), 'isCreateConversationCallInProgress')) throw new Error(`X did not make the group (${toasts.last})`);
        return null;
      }, 45_000, 'X to make the group').catch((e) => {
        throw new Error(/X did not/.test(e.message) ? e.message : 'X did not make the group');
      });
      return { conv: idOf(cid), cid, added, failed };
    });
    const notes = [];
    const name = (cmd.name || '').trim();
    if (name) {
      await sleep(human(800, 1500));
      try {
        await editGroup(made.conv, { title: name }, made.cid);
      } catch (e) {
        notes.push(`Made, but X did not take its name: ${e.message}`);
      }
    }
    return { conv: made.conv, added: made.added, failed: made.failed, notes };
  }

  // --------------------------------------------------------------- a group's screens
  /** The conversation's container (the client's per-conversation graph), as a group's info page makes one. */
  async function withContainer(conv, f, cid) {
    const g = found.graph;
    if (!g || !fn(get(g, 'convComponentContainer'))) throw new Error('X changed: the conversation container was not found');
    cid = cid || convIdObj(conv);
    const container = get(g, 'convComponentContainer').call(g, cid);
    try {
      return await f(container, cid);
    } finally {
      try {
        fn(get(container, 'dispose')) && get(container, 'dispose').call(container);
      } catch (e) {}
    }
  }
  /** Add people, as its screen: each from its search (in it already counts as added), then Done. */
  async function cmdAddMembers(cmd) {
    const A = need('AddGroupParticipantsEvent');
    return withContainer(cmd.conv, async (container, cid) => {
      const make = get(container, 'addGroupParticipantsComponent');
      if (!fn(make)) throw new Error('X changed: Add people was not found');
      const c = cancellation();
      const done = { value: false };
      const cb = plain({
        onFinished() {
          done.value = true;
        },
      });
      markInterface(cb, 'AddGroupParticipantsCallbacks');
      const comp = make.call(container, c, cid, cb);
      const toasts = followToasts(comp);
      try {
        const added = [];
        const failed = [];
        const picked = [];
        for (const p of cmd.people) {
          await sleep(human(400, 900));
          let s;
          try {
            s = await searchFor(comp, A, p.handle, p.id);
          } catch (e) {
            failed.push({ id: p.id, reason: e.message });
            continue;
          }
          if (get(s, 'alreadyParticipant') === true) {
            added.push(p.id);
            continue;
          }
          const user = suggestionUser(s);
          if (get(user, 'canBeAddedToGroup') === false) {
            failed.push({ id: p.id, reason: `X does not let you add them to a group${reasonOf(get(user, 'cannotBeAddedToGroupReason'))}` });
            continue;
          }
          fire(comp, new A.UserRowClicked(s));
          const ok = await waitFor(() => selectedIds(stateOf(comp), 'selectedUserIds').has(p.id), 4000, 'them to be picked').catch(() => null);
          if (ok) picked.push(p.id);
          else failed.push({ id: p.id, reason: 'X did not pick them' });
        }
        if (picked.length) {
          await sleep(human(400, 900));
          fire(comp, get(A, 'DoneClicked'));
          await waitFor(() => {
            if (done.value) return true;
            if (toasts.last && !get(stateOf(comp), 'isCallingApi')) throw new Error(`X did not add them (${toasts.last})`);
            return false;
          }, 30_000, 'X to add them').catch((e) => {
            throw new Error(/X did not/.test(e.message) ? e.message : 'X did not add them');
          });
          added.push(...picked);
        }
        return { added, failed };
      } finally {
        toasts.stop();
        c.cancel();
      }
    });
  }
  /** Edit Group: a new name and/or description typed in, then Save, as its screen. */
  async function editGroup(conv, change, cid) {
    const E = need('EditGroupMetadataEvent');
    return withContainer(conv, async (container, id) => {
      const make = get(container, 'editGroupMetadataComponent');
      if (!fn(make)) throw new Error('X changed: Edit Group was not found');
      const c = cancellation();
      const done = { value: false };
      const cb = plain({
        onFinished() {
          done.value = true;
        },
      });
      markInterface(cb, 'EditGroupMetadataCallbacks');
      const comp = make.call(container, c, id, cb);
      const toasts = followToasts(comp);
      try {
        await waitFor(() => get(stateOf(comp), 'metadata') || get(stateOf(comp), 'currentTitle') != null, 8000, 'Edit Group to load').catch(() => null);
        if (change.title != null) fire(comp, new E.TitleTextUpdated(change.title));
        if (change.description != null) fire(comp, new E.DescriptionTextUpdated(change.description));
        await waitFor(() => get(stateOf(comp), 'saveButtonEnabled'), 4000, 'Save').catch(() => {
          const st = stateOf(comp);
          throw new Error(numOf(get(st, 'descriptionCharactersRemaining')) < 0 ? 'X says the description is too long' : 'X did not offer to save that');
        });
        await sleep(human(300, 700));
        toasts.last = null;
        fire(comp, get(E, 'SaveButtonClicked'));
        await waitFor(() => {
          if (done.value) return true;
          if (toasts.last) throw new Error(`X did not save it (${toasts.last})`);
          return false;
        }, 20_000, 'X to save it').catch((e) => {
          throw new Error(/X did not/.test(e.message) ? e.message : 'X did not save it');
        });
        return { ok: true };
      } finally {
        toasts.stop();
        c.cancel();
      }
    }, cid);
  }
  /** What the inbox row says of a conversation: its settings and who is in it, with who runs it. */
  function cmdAbout(cmd) {
    const p = previewObjects.get(cmd.conv) || requestPreviews.get(cmd.conv);
    if (!p) throw new Error('X does not list this conversation in its inbox');
    const md = metaOf(p);
    const attrs = get(md, 'attributes');
    const people = [];
    for (const x of arr(first(md, ['sortedParticipants', 'currentParticipants'])).slice(0, 500)) {
      const id = idOf(get(x, 'userId')) || userIdOf(x);
      if (id) people.push({ id, admin: get(x, 'isAdmin') === true, current: get(x, 'isCurrentMember') !== false });
    }
    const me = get(md, 'selfParticipantIfCurrentMember');
    const raw = convRaw(p, true);
    return {
      conv: cmd.conv,
      group: raw ? raw.group : null,
      legacy: raw ? raw.legacy : null,
      request: isRequest(cmd.conv),
      title: strOf(get(attrs, 'customTitle')),
      description: strOf(get(attrs, 'customDescription')),
      avatarUrl: urlOf(get(attrs, 'customAvatarUrl')),
      muted: boolOf(get(attrs, 'muted')),
      ttl: numOf(get(attrs, 'defaultTtl')),
      adminOnlyEditGroupInfo: boolOf(get(attrs, 'adminOnlyEditGroupInfo')),
      adminOnlyAddMembers: boolOf(get(attrs, 'adminOnlyAddMembers')),
      adminOnlySendMessages: boolOf(get(attrs, 'adminOnlySendMessages')),
      participants: people,
      member: me != null ? true : people.length ? people.some((x) => x.id === selfId) : null,
      selfAdmin: me != null ? get(me, 'isAdmin') === true : people.some((x) => x.id === selfId && x.admin),
      users: raw ? raw.users : [],
    };
  }

  // --------------------------------------------------------------- typing
  /**
   * Say you are typing, as typing does: a character into the open conversation's composer and out again (its
   * UserChangedText; the core's typing handler sends at most one indicator every few seconds). Never over a draft
   * that is already there.
   */
  async function cmdTyping(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const C = need('ChatComposerEvent');
      const comp = composerOf(dm);
      if (!comp) return { ok: false, why: 'no composer' };
      const st = composerState(dm);
      if (strOf(get(st, 'text'))) return { ok: false, why: 'a draft is there' };
      onEvent(comp, new C.UserChangedText(' ', 1));
      await sleep(human(150, 350));
      if (strOf(get(composerState(dm), 'text')) === ' ') onEvent(comp, new C.UserChangedText('', 0));
      return { ok: true };
    }, { keepMs: 15_000 });
  }

  // --------------------------------------------------------------- forwarding
  /**
   * Forward a message, as its Forward action: the conversation's MessageActionClick with the Forward the message's
   * actions offer, then the dialog: the target from its suggestions (searched by name when it is not among the
   * first), an optional note, and Send.
   */
  async function cmdForward(cmd) {
    return withConversation(cmd.conv, async (dm) => {
      const D = need('DmEvent');
      const FE = need('ForwardMessageEvent');
      const item = findItem(dm, cmd.conv, cmd.message);
      if (!item) throw new Error('the message is not loaded in this conversation');
      let action = null;
      try {
        const acts = actionsFor(dm, item);
        for (const a of [...arr(get(acts, 'rail')), ...arr(get(acts, 'overflow'))]) if (kname(a) === 'Forward' && knames(a).includes('ChatMessageAction')) action = a;
      } catch (e) {}
      if (!action) {
        const A = K.ChatMessageAction;
        if (!A || !fn(A.Forward)) throw new Error('X does not offer to forward this message');
        action = new A.Forward(item, null);
      }
      fire(dm, new D.MessageActionClick(action));
      const fc = await waitFor(() => {
        const c = get(dm, 'forwardComponent');
        return c && get(stateOf(c), 'forwardedMessage') ? c : null;
      }, 6000, 'the forward dialog').catch(() => {
        throw new Error('X did not open its forward dialog');
      });
      const close = () => {
        try {
          fire(fc, get(FE, 'BackButtonClicked'));
        } catch (e) {}
      };
      const match = (s) => {
        const r = get(s, 'result');
        const inbox = get(r, 'inboxItem');
        const id = idOf(get(inbox, 'conversationId')) || idOf(get(get(inbox, 'preview'), 'conversationId'));
        if (id) return id === cmd.to;
        const u = get(r, 'user');
        return !!u && !!cmd.peer && userIdOf(u) === cmd.peer;
      };
      let s = arr(get(stateOf(fc), 'suggestions')).find(match);
      if (!s && cmd.query) {
        fire(fc, new FE.QueryChanged(cmd.query));
        s = await waitFor(() => arr(get(stateOf(fc), 'suggestions')).find(match), 10_000, 'the conversation among the suggestions').catch(() => null);
      }
      if (!s) {
        close();
        throw new Error('X does not offer that conversation to forward to');
      }
      await sleep(human(200, 500));
      fire(fc, new FE.SelectSuggestion(s));
      await waitFor(() => arr(get(stateOf(fc), 'selectedSuggestions')).length, 4000, 'it to be picked').catch(() => {
        close();
        throw new Error('X did not pick that conversation');
      });
      if (cmd.note) fire(fc, new FE.UserChangedText(cmd.note, cmd.note.length));
      await sleep(human(300, 700));
      fire(fc, get(FE, 'SendButtonClicked'));
      await waitFor(() => !get(stateOf(fc), 'forwardedMessage') || !get(valueOf(get(dm, 'state')), 'showingForwardMessageDialog'), 20_000, 'the forward to go').catch(() => {
        throw new Error('X did not send the forward');
      });
      return { ok: true };
    });
  }

  /** Which of these the page offers, from the classes and the graph found (called with classesChanged). */
  function gapsChanged() {
    const g = found.graph;
    const via = (k) => KVia[k] || 'module';
    const R = K.MessageRequestsEvent;
    const D = K.DmEvent;
    const N = K.NewDmEvent;
    const graphHas = (m) => !!g && fn(get(g, m));
    const reqVia = graphHas('messageRequestsComponent') ? 'graph' : 'page';
    mark('requests', !!(g && R && fn(R.AcceptRequestClicked)), reqVia);
    mark('answer', !!((R && fn(R.AcceptRequestClicked) && fn(R.DeleteRequestClicked) && fn(R.BlockRequestClicked)) || (D && get(D, 'AcceptMessageRequest'))), R && fn(R.AcceptRequestClicked) ? `list:${via('MessageRequestsEvent')}` : 'dm');
    const newDm = graphHas('newDmComponent') && !!N && fn(N.QueryChanged) && fn(N.SuggestionClicked);
    mark('openDirect', newDm || !!selfId, newDm ? 'search' : 'id');
    mark('createGroup', newDm && 'CreateAGroupItemClicked' in N && 'CreateButtonClicked' in N, 'newDm');
    mark('addMembers', graphHas('convComponentContainer') && !!K.AddGroupParticipantsEvent, 'container');
    mark('groupInfo', graphHas('convComponentContainer') && !!K.EditGroupMetadataEvent, 'container');
    mark('typing', !!(K.ChatComposerEvent && fn(K.ChatComposerEvent.UserChangedText)), 'composer');
    mark('forward', !!(D && fn(D.MessageActionClick) && K.ForwardMessageEvent), K.ChatMessageAction ? 'action' : 'action+new');
  }

  // ------------------------------------------------------------- diagnostics
  // Shapes only: Kotlin class names, key names, the types of values, counts. Never a value.
  const readable = (k) => /^[a-z][A-Za-z0-9]{2,}$/.test(k) && !/_\d+$/.test(k);
  function typeTag(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'function') return kclassName(v) ? `class:${kclassName(v)}` : 'fn';
    if (t !== 'object') return t;
    if (isFlow(v)) return `flow:${kname(get(v, 'state')) || typeTag(get(v, 'state'))}`;
    if (Array.isArray(v)) return `array(${v.length})`;
    const asList = fn(get(v, 'asJsReadonlyArrayView')) ? arr(v) : null;
    if (asList) return `list(${asList.length})`;
    if (fn(get(v, 'asJsReadonlyMapView'))) return `map(${entries(v).length})`;
    const n = kname(v);
    if (n && typeof get(v, 'ordinal') === 'number') return `enum:${n}.${enumName(v)}`;
    return n ? `obj:${n}` : 'obj';
  }
  function keysOf(v) {
    const out = new Set();
    try {
      for (const k of Object.keys(v)) if (readable(k)) out.add(k);
      let p = Object.getPrototypeOf(v);
      for (let i = 0; p && p !== Object.prototype && i < 5; i++, p = Object.getPrototypeOf(p)) {
        for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) if (k !== 'constructor' && readable(k) && (d.get || fn(d.value))) out.add(k);
      }
    } catch (e) {}
    return [...out].sort();
  }
  function shapeOf(v, depth) {
    if (!v || typeof v !== 'object') return typeTag(v);
    const out = { class: kname(v), parents: knames(v).slice(1), keys: {} };
    for (const k of keysOf(v).slice(0, 120)) {
      const x = get(v, k);
      out.keys[k] = depth > 0 && x && typeof x === 'object' && !isFlow(x) && !Array.isArray(x) && !fn(get(x, 'asJsReadonlyArrayView')) ? shapeOf(x, depth - 1) : typeTag(x);
    }
    return out;
  }
  function diagnose() {
    scan();
    const listState = found.list ? valueOf(get(found.list, 'state')) : null;
    const previews = listState ? arr(first(listState, ['previews', 'previewItems'])) : [];
    const open = [];
    for (const [conv, e] of dms) {
      const { st, ci, items } = chatItems(e.dm);
      const kinds = {};
      for (const it of items) kinds[kname(it) || 'plain'] = (kinds[kname(it) || 'plain'] || 0) + 1;
      const firstMsg = items.find(isMessage);
      open.push({
        conv,
        via: e.via,
        quiet: quiet.has(conv),
        component: shapeOf(e.dm, 0),
        state: shapeOf(st, 0),
        chatItems: shapeOf(ci, 0),
        itemKinds: kinds,
        message: firstMsg ? shapeOf(firstMsg, 1) : null,
        composer: shapeOf(composerState(e.dm), 0),
      });
    }
    // The event classes' subclasses by name, and how many arguments the ones used here take (a changed signature shows).
    const USED = {
      DmEvent: ['ScrolledToTop', 'VisibleReadableItemsChanged', 'ReplyToMessageClicked', 'ReactionPickerItemClick', 'DeleteMessageForAll', 'ResolveMediaImmediately', 'BackButtonClicked'],
      ChatComposerEvent: ['UserChangedText', 'RightButtonClicked', 'StartEditingMessage', 'StartReplyingToMessage', 'OnFileAttached'],
      ConversationListEvent: ['RowClicked', 'ScrolledToBottomOfConversations'],
      MessageRequestsEvent: ['AcceptRequestClicked', 'DeleteRequestClicked', 'BlockRequestClicked', 'ConfirmDelete', 'ConfirmBlock', 'ScrolledToBottom'],
      NewDmEvent: ['QueryChanged', 'SuggestionClicked', 'CreateAGroupItemClicked', 'CreateButtonClicked'],
      AddGroupParticipantsEvent: ['QueryChanged', 'UserRowClicked', 'DoneClicked'],
      EditGroupMetadataEvent: ['TitleTextUpdated', 'DescriptionTextUpdated', 'SaveButtonClicked'],
      ForwardMessageEvent: ['QueryChanged', 'SelectSuggestion', 'UserChangedText', 'SendButtonClicked', 'BackButtonClicked'],
      ChatMessageAction: ['Forward', 'DeleteForAll'],
    };
    const classes = {};
    for (const k of Object.keys(K)) {
      const c = K[k];
      if (!c) {
        classes[k] = null;
        continue;
      }
      const out = { via: KVia[k], class: kclassName(c), arity: c.length };
      if (USED[k]) {
        let names = [];
        try {
          names = Object.getOwnPropertyNames(c).filter((n) => /^[A-Z][A-Za-z0-9]+$/.test(n)).sort();
        } catch (e) {}
        out.subclasses = names;
        out.used = {};
        for (const n of USED[k]) {
          const d = Object.getOwnPropertyDescriptor(c, n);
          out.used[n] = !d ? 'missing' : d.get ? 'object' : fn(d.value) ? `class(${d.value.length})` : typeof d.value;
        }
      }
      classes[k] = out;
    }
    return {
      hook: HOOK_VERSION,
      page: { state: pageState(), path: location.pathname, pinComponent: kname(pinComponent) },
      react: { renderers, roots: rootCount(), fibers: counts.fibers, commits: counts.commits, scans: counts.scans, providers: Object.fromEntries(providerKinds) },
      graph: found.graph ? { via: hooks.graph.via, class: kname(found.graph), keys: keysOf(found.graph) } : null,
      modules: { loaded: chunkUrls.size, core: coreUrl ? fileOf(coreUrl) : null, coreVia, scanned: [...scannedUrls].map(fileOf), xchat: [...chunkUrls].filter((u) => /\/xchat\//.test(u)).length },
      classes,
      inbox: found.list
        ? { via: found.listVia, component: shapeOf(found.list, 0), state: shapeOf(listState, 0), previews: previews.length, preview: previews[0] ? shapeOf(previews[0], 2) : null }
        : null,
      requests: requestsComp || found.requestsUi ? { via: requestsComp ? 'graph' : 'page', state: shapeOf(stateOf(requestsComp || found.requestsUi), 0), previews: requestPreviews.size, signal: listState ? requestsSignal(listState).known : null } : null,
      graphFactories: found.graph ? ['messageRequestsComponent', 'newDmComponent', 'convComponentContainer'].filter((m) => fn(get(found.graph, m))) : [],
      open,
      hooks: selfTest().hooks,
      counts: { readsHeld: counts.readsHeld, readsSent: counts.readsSent, events: counts.events, dropped: counts.dropped },
      feed: feedDiagnose(),
    };
  }


  // ===================================================================== the feed
  // Signed in, x.com is X's own client, "responsive-web" (webpack, React, Redux with redux-thunk), with the XChat embed
  // drawn inside it. Its notifications and profiles are read through its own endpoint factories, called the way the
  // page calls them, so each request is the one the Notifications tab or a profile makes (same variables, features,
  // headers): nothing here builds a query.
  //
  //   - webpack: the runtime's require, from a chunk pushed onto `webpackChunk_twitter_responsive_web` (the runtime runs
  //     a chunk's function with its require); the chunk leaves the list again at once.
  //   - store: the Redux store, from react-redux's context value `{ store, subscription }` in the fiber trees (a
  //     provider's value or the Provider's memo: `provider`), or any value of a Redux store's shape (`shape`).
  //   - endpoints: the thunk's extra argument, `store.dispatch((dispatch, getState, extra) => extra)`: no action reaches
  //     a reducer. Its `api` (or itself) has `withEndpoint(factory)`, which hands the factory the page's API client.
  //   - notifications: the Notifications tab's timeline module (`getCreationOptions().network`: `getEndpoint(api)` is
  //     `api.withEndpoint(factory).fetchNotifications`, `getEndpointParams` its variables). Its chunk is lazy: loaded
  //     by the route's own loader (a module that loads the tab's chunks with `require.e` and requires the module), as
  //     opening the tab would (`loader`); found already loaded when the tab was opened (`module`). The module's other
  //     export, `updateLastSeenCursor`, marks notifications seen and is never called.
  //   - profiles: the factories with `fetchOneUser:(` (UserByRestId) and `fetchUserTweets:(` (UserTweets, the Posts
  //     tab), found by those words in the module sources (read with the page's untouched toString).
  //   - posts: the factory with `fetchTweetDetail:(` (TweetDetail, a post's page: what it answers and its replies),
  //     found the same way and called as opening a post calls it. It resolves to the conversation's URT timeline.
  //   - actions: the tweet actions factory (`sendTweet:function(`, with `unretweet(` in the same source): what a post's
  //     buttons and the composer call: like/unlike (FavoriteTweet, UnfavoriteTweet), retweet/unretweet (CreateRetweet,
  //     DeleteRetweet) and sendTweet (CreateTweet, or CreateNoteTweet for a long post). Called only when a command asks.
  //   - reactors: the factory with `fetchLikedBy:(` (Favoriters, Retweeters: a post's Likes and Reposts tabs). Its
  //     chunk is lazy (the TweetActivity route's, shared with QuoteTweetActivity; also TweetEditHistory's): loaded at
  //     the first `reactors` command by the route's own loader, as opening a post's likes would (`loader`), or found
  //     already loaded (`module`). `pending` until then.
  //
  // What comes back is forwarded as a whitelisted copy (FEED_KEYS: the fields feed.ts reads), the rest dropped.
  const CHUNKS = 'webpackChunk_twitter_responsive_web';
  const FEED_HOOKS = ['webpack', 'store', 'endpoints', 'notifications', 'profiles', 'posts', 'actions', 'reactors'];
  for (const n of FEED_HOOKS) hooks[n] = { ok: false, via: null };
  // Found at the first read (its chunk loads then), not before.
  hooks.notifications.via = 'pending';
  hooks.reactors.via = 'pending';
  const feed = { req: null, store: null, api: null, apiVia: null, notif: null, users: null, tweets: null, detail: null, actions: null, reactors: null, lastNotifications: null, lastUser: null, lastTweets: null, lastDetail: null, lastAct: null, lastCreated: null, lastReactors: null, loaderChunk: null, notifChunks: null, reactorsChunk: null, reactorsChunks: null };
  const srcOf = (f) => {
    try {
      return cloak.textOf(f) || '';
    } catch (e) {
      return '';
    }
  };

  function wpRequire() {
    if (feed.req) return feed.req;
    let chunks = null;
    try {
      chunks = window[CHUNKS];
    } catch (e) {}
    if (!chunks || !fn(get(chunks, 'push'))) return null;
    const probe = [
      [Symbol()],
      {},
      (r) => {
        if (fn(r) && r.m && typeof r.m === 'object') feed.req = r;
      },
    ];
    try {
      chunks.push(probe);
    } catch (e) {}
    try {
      const i = chunks.lastIndexOf(probe);
      if (i >= 0) chunks.splice(i, 1);
    } catch (e) {}
    if (feed.req) mark('webpack', true, 'chunk');
    return feed.req;
  }

  const triedStores = new WeakSet();
  const isStore = (s) => !!s && typeof s === 'object' && fn(get(s, 'dispatch')) && fn(get(s, 'getState')) && fn(get(s, 'subscribe')) && fn(get(s, 'replaceReducer'));
  /** Each value the fiber scan meets: the Redux store, by react-redux's context value or by its shape. */
  function feedOffer(v, where) {
    if (feed.api && hooks.store.via === 'provider') return;
    try {
      // react-redux's context value, `{ store, subscription }`: as a provider's value, or the Provider's useMemo.
      const inCtx = where === 'provider' || 'subscription' in v ? get(v, 'store') : null;
      const s = isStore(inCtx) ? inCtx : isStore(v) ? v : null;
      if (!s) return;
      const via = s === inCtx ? 'provider' : 'shape';
      if (feed.store === s) {
        if (via === 'provider') mark('store', true, via);
        return;
      }
      if (feed.api || triedStores.has(s)) return;
      triedStores.add(s);
      // The store whose thunk hands out the page's API (another Redux store, without it, is not the one).
      const api = thunkApi(s);
      if (!api && feed.store) return;
      feed.store = s;
      mark('store', true, via);
      if (api) {
        feed.api = api[0];
        feed.apiVia = api[1];
        mark('endpoints', true, api[1]);
      }
    } catch (e) {}
  }
  function thunkApi(store) {
    let extra = null;
    try {
      extra = store.dispatch((d, g, x) => x);
    } catch (e) {
      return null;
    }
    if (!extra || typeof extra !== 'object') return null;
    if (fn(get(extra, 'withEndpoint'))) return [extra, 'thunk'];
    const api = get(extra, 'api');
    if (api && fn(get(api, 'withEndpoint'))) return [api, 'thunk.api'];
    return null;
  }

  // Module sources are read once each (a set of the ids looked at), for the words below.
  const MARKS = { users: 'fetchOneUser:(', tweets: 'fetchUserTweets:(', detail: 'fetchTweetDetail:(', actions: 'sendTweet:function(', reactors: 'fetchLikedBy:(', notifications: 'fetchNotifications:(' };
  const marked = {};
  const looked = new Set();
  const loaders = [];
  const loaderKeys = new Set();
  let modulesRead = 0;
  function readModules() {
    const req = feed.req;
    const m = req && req.m;
    if (!m) return;
    let ids;
    try {
      ids = Object.keys(m);
    } catch (e) {
      return;
    }
    for (const id of ids) {
      if (looked.has(id)) continue;
      looked.add(id);
      modulesRead++;
      const s = srcOf(get(m, id));
      if (!s) continue;
      for (const k of Object.keys(MARKS)) if (s.indexOf(MARKS[k]) >= 0 && (marked[k] = marked[k] || []).length < 5) marked[k].push(id);
      // A route's loader: Promise.all over the chunks it needs (require.e), then the module. One module may hold many
      // (x.com's route table does), so each is kept on its own: its chunks and the module it then requires.
      if (s.indexOf('Promise.all([') >= 0) {
        for (const lm of s.matchAll(/Promise\.all\(\[((?:\w+\.e\(\d+\),?)+)\]\)\.then\(\(\)=>\w+\((\d+)\)\)/g)) {
          const key = lm[1] + '>' + lm[2];
          if (loaderKeys.has(key)) continue;
          loaderKeys.add(key);
          loaders.push({ chunks: [...lm[1].matchAll(/\.e\((\d+)\)/g)].map((c) => Number(c[1])), module: lm[2] });
        }
      }
    }
  }
  /** The first of the modules `ids` with an export whose source holds `word` (the factory), or null. */
  function exportIn(ids, word, also) {
    for (const id of ids || []) {
      const f = exportWith(id, word, also);
      if (f) return f;
    }
    return null;
  }
  /** The export of module `id` whose source holds `word` (the factory), or null. */
  function exportWith(id, word, also) {
    let ex;
    try {
      ex = feed.req(id);
    } catch (e) {
      return null;
    }
    const cands = [ex];
    try {
      for (const k of Object.keys(ex)) cands.push(get(ex, k));
    } catch (e) {}
    for (const c of cands) {
      if (!fn(c)) continue;
      const s = srcOf(c);
      if (s.indexOf(word) >= 0 && (!also || s.indexOf(also) >= 0)) return c;
    }
    return null;
  }
  /** The All timeline module among a module's exports: getCreationOptions().network fetching notifications. */
  function timelineIn(ns) {
    const cands = [];
    try {
      cands.push(get(ns, 'default'));
      for (const k of Object.keys(ns)) cands.push(get(ns, k));
    } catch (e) {}
    let any = null;
    for (const c of cands) {
      if (!c || typeof c !== 'object' || !fn(get(c, 'getCreationOptions'))) continue;
      let o = null;
      try {
        o = c.getCreationOptions();
      } catch (e) {}
      const net = get(o, 'network');
      if (!net || !fn(get(net, 'getEndpoint')) || !fn(get(net, 'getEndpointParams')) || srcOf(net.getEndpoint).indexOf('fetchNotifications') < 0) continue;
      let p = null;
      try {
        p = net.getEndpointParams({ count: 1 }, undefined);
      } catch (e) {}
      if (get(p, 'timelineType') === 'All') return c;
      any = any || c;
    }
    return any;
  }

  let probedAt = 0;
  /** Looks for what the feed needs (not the notifications, found at the first read), at most once a minute until found. */
  function feedProbe() {
    if (feed.req && feed.api && feed.users && feed.tweets && feed.detail && feed.actions && feed.reactors) return;
    if (Date.now() - probedAt < 60_000) return;
    probedAt = Date.now();
    wpRequire();
    if (!feed.req) return;
    readModules();
    if (!feed.users) feed.users = exportIn(marked.users, MARKS.users);
    if (!feed.tweets) feed.tweets = exportIn(marked.tweets, MARKS.tweets);
    mark('profiles', !!(feed.users && feed.tweets), 'module');
    if (!feed.detail) feed.detail = exportIn(marked.detail, MARKS.detail);
    mark('posts', !!feed.detail, 'module');
    if (!feed.actions) feed.actions = exportIn(marked.actions, MARKS.actions, 'unretweet(');
    mark('actions', !!feed.actions, 'module');
    // Loaded already (someone opened a post's likes): there. Else pending until the first `reactors` loads it.
    if (!feed.reactors && (feed.reactors = exportIn(marked.reactors, MARKS.reactors))) mark('reactors', true, 'module');
    // The tab was opened already: its module is there.
    if (!feed.notif && notifIn(marked.notifications)) mark('notifications', true, 'module');
  }
  /**
   * No timeline module, but the tab's endpoint factory is loaded: the same call the tab makes for the All timeline,
   * `fetchNotifications({count, cursor, timelineType: 'All'})`, shaped as a timeline module so the read is the same.
   */
  function factoryNotif() {
    const f = exportIn(marked.notifications, MARKS.notifications);
    if (!f) return null;
    const network = { getEndpoint: (api) => api.withEndpoint(f).fetchNotifications, getEndpointParams: (o) => ({ count: o.count, cursor: o.cursor, timelineType: 'All' }) };
    return { factory: true, getCreationOptions: () => ({ network }) };
  }
  function notifIn(ids) {
    for (const id of ids || []) {
      try {
        feed.notif = timelineIn(feed.req(id));
      } catch (e) {}
      if (feed.notif) return feed.notif;
    }
    return null;
  }

  /** The Notifications tab's timeline module, loading its chunk the way opening the tab does. */
  async function notificationsModule() {
    if (feed.notif) return feed.notif;
    probedAt = 0;
    feedProbe();
    if (feed.notif) return feed.notif;
    const req = feed.req;
    if (!req) throw new Error('X changed: webpack was not found, so notifications cannot be read');
    const name = (cid) => {
      try {
        return String(req.u(cid));
      } catch (e) {
        return '';
      }
    };
    readModules();
    for (const l of loaders) {
      const tab = l.chunks.find((c) => /^bundle\.Notifications\./.test(name(c))) ?? l.chunks.find((c) => /(^|~)bundle\.Notifications[.~]/.test(name(c)));
      if (tab === undefined) continue;
      let ns = null;
      try {
        // The same chunks, in the same call, as opening the tab loads; then the module the route requires.
        await Promise.all(l.chunks.map((c) => req.e(c)));
        ns = req(l.module);
      } catch (e) {
        log('warn', 'the notifications chunk would not load');
        continue;
      }
      feed.loaderChunk = name(tab).replace(/\.\w+\.js$/, '');
      const t = timelineIn(ns) || (readModules(), notifIn(marked.notifications)) || factoryNotif();
      if (t) {
        feed.notif = t;
        mark('notifications', true, 'loader');
        return t;
      }
    }
    readModules();
    if (notifIn(marked.notifications) || (feed.notif = factoryNotif())) {
      mark('notifications', true, 'module');
      return feed.notif;
    }
    mark('notifications', false, null);
    // For diagnostics: the loaders' chunk names that speak of notifications (public file names, nothing personal).
    feed.notifChunks = [...new Set(loaders.flatMap((l) => l.chunks.map(name)).filter((n) => /otification/.test(n)))].slice(0, 20);
    throw new Error('X changed: the notifications timeline was not found');
  }
  function feedApi() {
    probedAt = 0;
    feedProbe();
    if (!feed.store) throw new Error('X changed: the Redux store was not found');
    if (!feed.api) throw new Error('X changed: the endpoints (withEndpoint) were not found');
    return feed.api;
  }

  /** One page of the All notifications, as the tab asks for it (`cursor`: Top for newer, Bottom for older). */
  async function feedRead(cmd) {
    const api = feedApi();
    const mod = await notificationsModule();
    const net = mod.getCreationOptions().network;
    let state;
    try {
      state = feed.store.getState();
    } catch (e) {}
    const params = net.getEndpointParams({ count: Math.min(Math.max(cmd.count || 40, 1), 100), cursor: typeof cmd.cursor === 'string' ? cmd.cursor : undefined }, state);
    const res = await net.getEndpoint(api)(params);
    feed.lastNotifications = res;
    return { timeline: copyFeed(res, 'notifications') };
  }
  /** Someone's profile and Posts tab, as opening their profile asks for them. */
  async function profileRead(cmd) {
    const api = feedApi();
    if (!feed.users || !feed.tweets) throw new Error("X changed: the profile endpoints were not found");
    if (!/^\d{1,25}$/.test(String(cmd.user))) throw new Error('not a user id');
    const users = api.withEndpoint(feed.users);
    const tweets = api.withEndpoint(feed.tweets);
    const [u, t] = await Promise.all([users.fetchOneUser({ user_id: cmd.user }), sleep(human(80, 300)).then(() => tweets.fetchUserTweets({ count: 20, cursor: undefined, userId: cmd.user }))]);
    feed.lastUser = u;
    feed.lastTweets = t;
    return { user: copyFeed(u, 'user'), tweets: copyFeed(t, 'tweets') };
  }
  /**
   * One post's page, as opening it asks for it: TweetDetail for `cmd.post` (the focal post), what it answers and its
   * replies, ranked as X ranks them by default; `cmd.cursor` (a Bottom or ShowMoreThreads cursor of an earlier page)
   * for more replies. Nothing is liked, viewed or marked: this is only the read.
   */
  async function postRead(cmd) {
    const api = feedApi();
    if (!feed.detail) throw new Error('X changed: the post endpoint (TweetDetail) was not found');
    if (!/^\d{1,25}$/.test(String(cmd.post))) throw new Error('not a post id');
    if (cmd.cursor !== undefined && (typeof cmd.cursor !== 'string' || !cmd.cursor || cmd.cursor.length > 2000)) throw new Error('not a cursor');
    const res = await api.withEndpoint(feed.detail).fetchTweetDetail({ focalTweetId: String(cmd.post), cursor: cmd.cursor || undefined, referrer: 'tweet', rankingMode: 'Relevance' });
    feed.lastDetail = res;
    return { detail: copyFeed(res, 'detail', DETAIL_MAX_NODES) };
  }

  // ------------------------------------------------------- answering on X
  // Likes, reposts and posts, each the one call a post's button or the composer makes, made once when the command
  // comes: never retried here (a write that failed is answered as failed, with X's words), never before.
  const POST_ID = /^\d{1,25}$/;
  /** X's own words for a failed call (its GraphQL `errors`, else the error's message), and its code when it gave one. */
  function xError(e) {
    const errs = get(e, 'errors');
    const first = Array.isArray(errs) && errs.length ? errs[0] : null;
    const msg = (first && typeof get(first, 'message') === 'string' && get(first, 'message')) || String((e && e.message) || e || 'X failed');
    const code = first && typeof get(first, 'code') === 'number' ? get(first, 'code') : null;
    return { message: msg.slice(0, 280), code };
  }
  function actionsApi() {
    const api = feedApi();
    if (!feed.actions) throw new Error('X changed: the post actions (sendTweet, like, retweet) were not found');
    return api.withEndpoint(feed.actions);
  }
  // Already as asked: X says so with these codes (139: already liked; 327: already reposted). The post stands as asked.
  const ALREADY = { like: 139, repost: 327 };
  /** Like, unlike, repost or unrepost one post, as its buttons do. Answers how it stands after: `{ liked }` or `{ reposted }`. */
  async function postAct(cmd) {
    if (!POST_ID.test(String(cmd.post))) throw new Error('not a post id');
    const call = { like: 'like', unlike: 'unlike', repost: 'retweet', unrepost: 'unretweet' }[cmd.act];
    if (!call) throw new Error('not a post action');
    const a = actionsApi();
    if (!fn(get(a, call))) throw new Error(`X changed: the post action ${call} was not found`);
    try {
      feed.lastAct = await a[call]({ id: String(cmd.post) });
    } catch (e) {
      const x = xError(e);
      if (x.code === null || x.code !== ALREADY[cmd.act]) throw new Error(x.message);
    }
    return cmd.act === 'like' || cmd.act === 'unlike' ? { liked: cmd.act === 'like' } : { reposted: cmd.act === 'repost' };
  }
  /** One post as TweetResultByRestId gives it (the post page's factory without replies): `{ result: Tweet }`. */
  async function oneTweet(id) {
    if (!feed.detail) throw new Error('X changed: the post endpoint (TweetDetail) was not found');
    return feedApi().withEndpoint(feed.detail).fetchTweetDetail({ focalTweetId: String(id), withReplies: false });
  }
  /** The handle of a post's author from TweetResultByRestId's answer, or null. */
  function authorHandle(r) {
    let t = get(r, 'result');
    if (get(t, '__typename') === 'TweetWithVisibilityResults') t = get(t, 'tweet');
    const u = get(get(get(t, 'core'), 'user_results'), 'result');
    const h = get(get(u, 'core'), 'screen_name') || get(get(u, 'legacy'), 'screen_name');
    return typeof h === 'string' && /^\w{1,50}$/.test(h) ? h : null;
  }
  /**
   * A post, a reply (`replyTo`) or a quote (`quote`: its link, https://x.com/<handle>/status/<id>, as the composer
   * attaches it), through the composer's own sendTweet. Once X has made it, the answer is the made post: read back as
   * one post (`tweet`), or, when that read fails, what sendTweet itself gave (`created`, normalized). Nothing after
   * the send throws: a post that was made is never answered as failed.
   */
  async function publish(cmd) {
    const text = cmd.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 25_000) throw new Error('nothing to post');
    if (cmd.replyTo !== undefined && !POST_ID.test(String(cmd.replyTo))) throw new Error('not a post id to reply to');
    if (cmd.quote !== undefined && !POST_ID.test(String(cmd.quote))) throw new Error('not a post id to quote');
    const a = actionsApi();
    if (!fn(get(a, 'sendTweet'))) throw new Error('X changed: sendTweet was not found');
    const options = { status: text };
    if (cmd.replyTo) {
      options.in_reply_to_status_id = String(cmd.replyTo);
      options.exclude_reply_user_ids = '';
    }
    if (cmd.quote) {
      // The quoted post's link names its author, as the composer's does: read the post first (it may be gone).
      let q = null;
      try {
        q = await oneTweet(cmd.quote);
      } catch (e) {
        throw new Error(`X did not give the post to quote: ${xError(e).message}`);
      }
      const handle = authorHandle(q);
      if (!handle) throw new Error('X did not give the post to quote');
      options.attachment_url = `https://x.com/${handle}/status/${cmd.quote}`;
      await sleep(human(300, 900));
    }
    let res;
    try {
      res = await a.sendTweet(options);
    } catch (e) {
      throw new Error(xError(e).message);
    }
    feed.lastCreated = res;
    const tweets = get(get(res, 'entities'), 'tweets');
    let id = get(res, 'result');
    if (typeof id !== 'string' || !POST_ID.test(id)) {
      id = null;
      try {
        id = Object.keys(tweets || {}).find((k) => POST_ID.test(k)) || null;
      } catch (e) {}
    }
    if (!id) return { id: null, created: copyFeed(res, 'created') };
    const created = copyFeed({ entities: { tweets: { [id]: get(tweets, id) } }, result: id }, 'created');
    let tweet = null;
    try {
      await sleep(human(400, 900));
      tweet = copyFeed(await oneTweet(id), 'tweet');
    } catch (e) {
      log('warn', 'the new post could not be read back; answering with what sendTweet gave');
    }
    return { id, created, tweet };
  }

  /** The Favoriters/Retweeters factory, loading its chunk the way opening a post's likes does. */
  async function reactorsFactory() {
    if (feed.reactors) return feed.reactors;
    const req = feed.req;
    if (!req) throw new Error('X changed: webpack was not found, so who liked a post cannot be read');
    readModules();
    if ((feed.reactors = exportIn(marked.reactors, MARKS.reactors))) {
      mark('reactors', true, 'module');
      return feed.reactors;
    }
    const name = (cid) => {
      try {
        return String(req.u(cid));
      } catch (e) {
        return '';
      }
    };
    // The post's activity route first (Likes, Reposts), then its edit history's: both chunks hold the factory.
    const ROUTES = [/(^|~)bundle\.TweetActivity[.~]/, /(^|~)bundle\.TweetEditHistory[.~]/];
    for (const re of ROUTES) {
      for (const l of loaders) {
        const hit = l.chunks.find((c) => re.test(name(c)));
        if (hit === undefined) continue;
        try {
          await Promise.all(l.chunks.map((c) => req.e(c)));
          req(l.module);
        } catch (e) {
          log('warn', 'the post activity chunk would not load');
          continue;
        }
        readModules();
        if ((feed.reactors = exportIn(marked.reactors, MARKS.reactors))) {
          feed.reactorsChunk = name(hit).replace(/\.\w+\.js$/, '');
          mark('reactors', true, 'loader');
          return feed.reactors;
        }
      }
    }
    mark('reactors', false, null);
    feed.reactorsChunks = [...new Set(loaders.flatMap((l) => l.chunks.map(name)).filter((n) => /Activity|EditHistory/.test(n)))].slice(0, 20);
    throw new Error('X changed: the likes and reposts endpoint (fetchLikedBy) was not found');
  }
  /** Who liked (`of` like) or reposted (repost) a post, a page as its Likes or Reposts tab asks for it, ranked. */
  async function reactorsRead(cmd) {
    const api = feedApi();
    if (!POST_ID.test(String(cmd.post))) throw new Error('not a post id');
    if (cmd.of !== 'like' && cmd.of !== 'repost') throw new Error('not likes or reposts');
    if (cmd.cursor !== undefined && (typeof cmd.cursor !== 'string' || !cmd.cursor || cmd.cursor.length > 2000)) throw new Error('not a cursor');
    const f = await reactorsFactory();
    const e = api.withEndpoint(f);
    const params = { count: 20, cursor: cmd.cursor || undefined, enableRanking: true, tweetId: String(cmd.post) };
    let res;
    try {
      res = await (cmd.of === 'like' ? e.fetchLikedBy(params) : e.fetchRetweetedBy(params));
    } catch (err) {
      throw new Error(xError(err).message);
    }
    feed.lastReactors = res;
    return { timeline: copyFeed(res, 'reactors') };
  }

  // The fields feed.ts reads (timelines, notifications, users, posts), and nothing else. Keys of digits are ids (the
  // user lookup's normalized `entities.users`).
  const FEED_KEYS = new Set(
    (
      'instructions type entries entry entryId sortIndex content entryType __typename itemContent itemType items item cursorType value ' +
      'clientEventInfo element component promotedMetadata displayType tweetDisplayType ' +
      'id timestamp_ms notification_icon rich_message text notification_url url urlType template from_users target_objects ' +
      'user_results tweet_results result rest_id id_str core name screen_name created_at avatar image_url legacy description ' +
      'profile_bio entities urls expanded_url display_url followers_count friends_count statuses_count location ' +
      'relationship_perspectives following followed_by profile_image_url_https is_blue_verified verified user_id_str ' +
      'full_text display_text_range favorite_count retweet_count reply_count quote_count in_reply_to_status_id_str ' +
      'in_reply_to_user_id_str in_reply_to_screen_name retweeted_status_result quoted_status_result quoted_status_permalink ' +
      'note_tweet note_tweet_results entity_set media extended_entities media_url_https original_info width height ' +
      'ext_alt_text views count tweet user users timeline timeline_v2 data reason ' +
      // A post's page (TweetDetail): the thread a post is in, conversation modules, the instructions that add to them.
      'conversation_id_str moduleItems moduleEntryId moduleItemEntryId prepend direction displayTreatment actionText ' +
      'threaded_conversation_with_injections_v2 ' +
      // What you did to a post; a made post (sendTweet's normalized answer, a post read back alone); who liked or
      // reposted (Favoriters, Retweeters: user entries).
      'favorited retweeted tweets tweetResult user_id_str userDisplayType verification'
    ).split(' '),
  );
  const FEED_MAX_NODES = 60_000;
  // A long thread's page is bigger than a notifications page; and its cursors, which come last, are copied first (an
  // entry's order among the others is kept), so a page cut short still says where more replies are.
  const DETAIL_MAX_NODES = 200_000;
  const isCursorEntry = (e) => {
    const id = get(e, 'entryId');
    return typeof id === 'string' && (id.startsWith('cursor-') || id.indexOf('-cursor-') >= 0) ? 1 : 0;
  };
  function copyFeed(v, kind, max = FEED_MAX_NODES) {
    let nodes = 0;
    let cut = false;
    const walk = (x, depth) => {
      if (x == null) return null;
      const t = typeof x;
      if (t === 'string') return x.length > 20_000 ? x.slice(0, 20_000) : x;
      if (t === 'number') return Number.isFinite(x) ? x : null;
      if (t === 'boolean') return x;
      if (t === 'bigint') return String(x);
      if (t !== 'object' || depth > 40) return null;
      if (++nodes > max) {
        cut = true;
        return null;
      }
      if (Array.isArray(x)) {
        const xs = x.slice(0, 500);
        if (kind === 'detail') xs.sort((a, b) => isCursorEntry(b) - isCursorEntry(a));
        return xs.map((y) => walk(y, depth + 1));
      }
      const out = {};
      let keys;
      try {
        keys = Object.keys(x);
      } catch (e) {
        return null;
      }
      for (const k of keys) if (FEED_KEYS.has(k) || /^\d{1,25}$/.test(k)) out[k] = walk(get(x, k), depth + 1);
      return out;
    };
    const out = walk(v, 0);
    if (cut) drop(`${kind}.too-big`);
    return out;
  }

  // Diagnostics: shapes of what was found and of the last answers (keys and types; ids as <id>), never a value.
  function jsonShape(v, depth) {
    if (v === null || v === undefined || typeof v !== 'object') return typeTag(v);
    if (depth <= 0) return Array.isArray(v) ? `array(${v.length})` : 'obj';
    if (Array.isArray(v)) return { array: v.length, first: v.length ? jsonShape(v[0], depth - 1) : null };
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (++n > 60) break;
      out[/^\d+$/.test(k) ? '<id>' : k.slice(0, 60)] = jsonShape(get(v, k), depth - 1);
    }
    return out;
  }
  function feedDiagnose() {
    let state = null;
    try {
      state = feed.store && feed.store.getState();
    } catch (e) {}
    return {
      hooks: Object.fromEntries(FEED_HOOKS.map((n) => [n, hooks[n]])),
      webpack: feed.req ? { modules: (() => { try { return Object.keys(feed.req.m).length; } catch (e) { return null; } })(), read: modulesRead, loaders: loaders.length, marked: Object.keys(marked), u: fn(feed.req.u), e: fn(feed.req.e) } : null,
      store: feed.store ? { keys: keysOf(feed.store), state: state && typeof state === 'object' ? Object.keys(state).slice(0, 120).sort() : typeTag(state) } : null,
      endpoints: feed.api ? { via: feed.apiVia, keys: keysOf(feed.api) } : null,
      notifications: feed.notif ? { keys: keysOf(feed.notif), options: jsonShape(feed.notif.getCreationOptions(), 2), chunk: feed.loaderChunk } : { loaders: loaders.length, chunks: feed.notifChunks || null, marked: (marked.notifications || []).length },
      reactors: feed.reactors ? { chunk: feed.reactorsChunk } : { chunks: feed.reactorsChunks || null, marked: (marked.reactors || []).length },
      actions: feed.actions ? { keys: (() => { try { return Object.keys(feed.api.withEndpoint(feed.actions)).slice(0, 80).sort(); } catch (e) { return null; } })() } : { marked: (marked.actions || []).length },
      responses: { notifications: jsonShape(feed.lastNotifications, 12), user: jsonShape(feed.lastUser, 6), tweets: jsonShape(feed.lastTweets, 12), detail: jsonShape(feed.lastDetail, 12), act: jsonShape(feed.lastAct, 8), created: jsonShape(feed.lastCreated, 6), reactors: jsonShape(feed.lastReactors, 12) },
    };
  }

  // ------------------------------------------------------------------ wiring
  async function runCommand(cmd) {
    switch (cmd.kind) {
      case 'selftest':
        scan();
        return selfTest();
      case 'diagnose':
        return diagnose();
      case 'inbox':
        scan();
        return emitInbox(true);
      case 'history':
        return serial(() => cmdHistory(cmd));
      case 'send':
        return serial(() => cmdSend(cmd));
      case 'edit':
        return serial(() => cmdEdit(cmd));
      case 'unsend':
        return serial(() => cmdUnsend(cmd));
      case 'react':
        return serial(() => cmdReact(cmd));
      case 'markRead':
        return serial(() => cmdMarkRead(cmd));
      case 'media':
        return serial(() => cmdMedia(cmd));
      case 'sync':
        return serial(() => withConversation(cmd.conv, async () => ({ count: (emitMessages(cmd.conv) || { messages: [] }).messages.length })));
      case 'feed':
        return feedRead(cmd);
      case 'profile':
        return profileRead(cmd);
      case 'post':
        return postRead(cmd);
      case 'postAct':
        return postAct(cmd);
      case 'publish':
        return publish(cmd);
      case 'reactors':
        return reactorsRead(cmd);
      case 'requests':
        await lookAtRequests();
        return emitRequests(true) || { requests: [], loading: false, more: false };
      case 'answer':
        return serial(() => cmdAnswer(cmd));
      case 'openDirect':
        return serial(() => cmdOpenDirect(cmd));
      case 'createGroup':
        return serial(() => cmdCreateGroup(cmd));
      case 'addMembers':
        return serial(() => cmdAddMembers(cmd));
      case 'about':
        return cmdAbout(cmd);
      case 'editGroup':
        return serial(() => editGroup(cmd.conv, { title: cmd.title, description: cmd.description }));
      case 'typing':
        return serial(() => cmdTyping(cmd));
      case 'forward':
        return serial(() => cmdForward(cmd));
      default:
        throw new Error('unknown command ' + cmd.kind);
    }
  }
  cloak.onDown((payload) => {
    if (payload.t === 'settings') {
      Object.assign(settings, payload.settings || {});
      return;
    }
    if (payload.t !== 'cmd') return;
    Promise.resolve()
      .then(() => runCommand(payload.cmd || {}))
      .then((result) => post({ t: 'reply', id: payload.id, ok: true, result }))
      .catch((err) => post({ t: 'reply', id: payload.id, ok: false, error: String((err && err.message) || err).slice(0, 300) }));
  });

  installDevtools();
  post({ t: 'hook', version: HOOK_VERSION, path: location.pathname });
  const poll = () => {
    try {
      scan();
      if (found.graph && !K.DmEvent) void findClasses();
      if (!hooks.self.ok) findSelf();
    } catch (e) {}
    try {
      feedProbe();
    } catch (e) {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  setInterval(poll, 5000);
  setTimeout(reportSelfTest, 1500);
  log('info', `hook ${HOOK_VERSION} installed; navigator.webdriver=${String(navigator.webdriver)}`);
})();
