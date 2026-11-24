/*
 * MAIN-world content script on partiful.com, at document_start. partiful.com is a Next.js app (pages router, built
 * with Turbopack). Everything it shows comes from:
 *   - the page's own server-rendered data (`__NEXT_DATA__`, and `/_next/data/<buildId>/<path>.json` when the app moves
 *     between pages): Explore is only this;
 *   - Firebase Cloud Functions at https://api.partiful.com/<name>, called the way the Firebase SDK's httpsCallable
 *     calls them: POST, `{ data: { params, paging?, userId, client: 'web' } }`, `Authorization: Bearer <ID token>`
 *     when signed in, the answer `{ result: { data, paging? } }`;
 *   - Stream Chat (chat.stream-io-api.com) for chats, with the token getStreamUserToken gives.
 * docs/partiful.md lists every call and where in the bundle it was read.
 *
 * This hook makes only the calls in CALLS below, each as the app makes it for the same screen, with ids, cursors and
 * the city checked first. The sign-in token is read where the Firebase SDK keeps it (IndexedDB firebaseLocalStorageDb,
 * or web storage) and never leaves the page; neither does the Stream token. It never marks notifications read.
 *
 * The hidden-list rule: every getGuests answer leaves here without its rows' RSVP history, RSVP times and notes
 * (Partiful sends them even for a list the host hid, with the names blanked). The extractor never asks for the guests
 * of a hidden list in the first place.
 *
 * It talks to content.js over the channel in main-world.js (put in below when the extension is copied). Plain JS on
 * purpose (no build step).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  /*@include command-watch@*/
  if (!cloak.once()) return;
  const HOOK_VERSION = 1;
  const settings = { testOrigin: null };
  // The page's fetch as it was at document_start, before any of its scripts ran.
  const pageFetch = window.fetch;
  // Partiful's Stream Chat app key, as the app passes it to StreamChat.getInstance (a public key, in the bundle).
  const STREAM_KEY = 'vpkgtsebxkk2';
  const STREAM_CLIENT = 'stream-chat-javascript-client-browser-8.60.0';

  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg: String(msg).slice(0, 300) });
  const watch = commandWatch({ post, log });
  const fnBase = () => (settings.testOrigin ? settings.testOrigin + '/__api' : 'https://api.partiful.com');
  const streamBase = () => (settings.testOrigin ? settings.testOrigin + '/__stream' : 'https://chat.stream-io-api.com');

  // ------------------------------------------------------------- who is in
  /** The Firebase SDK's signed-in user: { uid, token, expires }, or null. Never opens a database that is not there. */
  async function authUser() {
    const pick = (v) => {
      const u = v && typeof v === 'object' ? v : null;
      const st = u && u.stsTokenManager;
      if (!u || typeof u.uid !== 'string' || !st || typeof st.accessToken !== 'string') return null;
      return { uid: u.uid, token: st.accessToken, expires: Number(st.expirationTime) || 0, name: typeof u.displayName === 'string' ? u.displayName : null };
    };
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k && k.indexOf('firebase:authUser:') === 0) {
            const got = pick(JSON.parse(store.getItem(k)));
            if (got) return got;
          }
        }
      } catch (e) {}
    }
    try {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      if (!dbs.some((d) => d && d.name === 'firebaseLocalStorageDb')) return null;
      return await new Promise((resolve) => {
        const req = indexedDB.open('firebaseLocalStorageDb');
        // It was listed, so it exists: never create it (the SDK makes its store when it first does).
        req.onupgradeneeded = () => {
          try {
            req.transaction.abort();
          } catch (e) {}
          resolve(null);
        };
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
              db.close();
              return resolve(null);
            }
            const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
            all.onsuccess = () => {
              db.close();
              const row = (all.result || []).find((r) => r && typeof r.fbase_key === 'string' && r.fbase_key.indexOf('firebase:authUser:') === 0);
              resolve(row ? pick(row.value) : null);
            };
            all.onerror = () => {
              db.close();
              resolve(null);
            };
          } catch (e) {
            try {
              db.close();
            } catch (e2) {}
            resolve(null);
          }
        };
      });
    } catch (e) {
      return null;
    }
  }

  let loadedAt = 0;
  let lastPage = '';
  let lastAuth = null;
  /** 'loading' until the page has loaded (and Firebase had a moment), then 'ready' signed in or 'login'. */
  async function pageState() {
    lastAuth = await authUser();
    if (/^\/login/.test(location.pathname)) return 'login';
    if (lastAuth) return 'ready';
    return loadedAt && Date.now() - loadedAt > 2000 ? 'login' : 'loading';
  }
  async function reportPage() {
    const state = await pageState();
    const self = lastAuth ? { id: lastAuth.uid, name: lastAuth.name } : null;
    const s = JSON.stringify([state, location.pathname, self && self.id]);
    if (s === lastPage) return;
    lastPage = s;
    post({ t: 'page', state, path: location.pathname.slice(0, 200), self });
  }

  // --------------------------------------------------------------- checks
  const ID = /^[A-Za-z0-9_-]{6,64}$/;
  const CID = /^[A-Za-z0-9_-]{4,64}$/;
  const SID = /^[\w!-]{1,128}$/;
  const CITY = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const bad = (what) => {
    throw new Error('not ' + what);
  };
  const id = (v, what) => (typeof v === 'string' && ID.test(v) ? v : bad('a Partiful ' + what + ' id'));
  const cid = (v, what) => (typeof v === 'string' && CID.test(v) ? v : bad('a Partiful ' + what + ' id'));
  const sid = (v) => (typeof v === 'string' && SID.test(v) ? v : bad('a chat id'));
  const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v : bad('words to send (1 to ' + max + ' characters)'));
  const cursor = (v) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' && /^[\w\-.:=+/%]{1,500}$/.test(v) ? v : bad('a Partiful cursor'));

  // Keys nothing on the other side reads, dropped from the copy.
  const DROP = new Set(['blurHash', 'contentWarningMetadata', 'displaySettings', 'storageUri', 'crop', 'sitemapLastModifiedAt', 'offersJsonLd', 'structuredEventLocationJsonLd', 'questionnaire', 'questionnaireVersions', 'findATime', 'checkInStaffIds']);
  function trim(v, depth) {
    if (depth > 14 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => trim(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) if (!DROP.has(k)) out[k] = trim(v[k], depth + 1);
    return out;
  }
  // From each getGuests row: what Partiful sends about an RSVP besides who and their status. Never leaves the page.
  const RSVP_PRIVATE = ['rsvpHistory', 'rsvpDate', 'rsvpMessage', 'message', 'rsvpImage', 'invitedBy', 'questionnaireResponse', 'plusOnes'];
  function withoutRsvpDetail(result) {
    const rows = result && Array.isArray(result.data) ? result.data : [];
    return {
      data: rows.map((r) => {
        const out = {};
        for (const k of Object.keys(r || {})) if (RSVP_PRIVATE.indexOf(k) < 0) out[k] = r[k];
        return out;
      }),
      paging: result && result.paging ? { nextCursor: typeof result.paging.nextCursor === 'string' ? result.paging.nextCursor : null } : null,
    };
  }

  // -------------------------------------------------------------- calls
  let reloadAt = 0;
  /** A function call as httpsCallable makes it; `{ data, paging }` or an Error in Partiful's words. */
  async function fn(name, params, paging, opts) {
    const auth = await authUser();
    if (opts && opts.signedIn && !auth) throw new Error('Partiful is not signed in (live view)');
    if (auth && auth.expires && auth.expires < Date.now() + 30000) {
      // The SDK refreshes its token while the page is open; one that ran out is refreshed by a reload.
      if (Date.now() - reloadAt > 120000) {
        reloadAt = Date.now();
        setTimeout(() => location.reload(), 200);
      }
      throw new Error('the Partiful sign-in on the page is out of date: reloading the page to refresh it');
    }
    const data = { params: params || {} };
    if (paging) data.paging = paging;
    if (auth) data.userId = auth.uid;
    data.client = 'web';
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + auth.token;
    const res = await pageFetch.call(window, fnBase() + '/' + name, { method: 'POST', headers, body: JSON.stringify({ data }) });
    let body = null;
    const type = res.headers.get('content-type') || '';
    if (type.indexOf('json') >= 0) {
      try {
        body = await res.json();
      } catch (e) {}
    }
    if (!res.ok || !body || body.error) {
      const said = body && body.error && (body.error.message || body.error.status);
      const challenge = !body && (res.status === 403 || res.status === 503) && /text\/html/.test(type);
      const e = new Error(challenge ? 'Partiful answered with a check for people (' + res.status + '): open the live view' : 'Partiful answered ' + res.status + (said ? ': ' + String(said).slice(0, 160) : ''));
      e.status = res.status;
      throw e;
    }
    const r = body.result || {};
    return { data: trim(r.data, 0), paging: r.paging || null };
  }

  /** Explore: the page's own data for /explore/<city> (or /explore), as the app fetches it between pages. */
  async function explore(c) {
    const city = c.city === undefined || c.city === null ? null : typeof c.city === 'string' && CITY.test(c.city) ? c.city : bad('a Partiful place (like sf or nyc)');
    const path = city ? '/explore/' + city : '/explore';
    const nd = window.__NEXT_DATA__;
    const build = nd && typeof nd.buildId === 'string' && /^[\w-]{1,80}$/.test(nd.buildId) ? nd.buildId : null;
    if (build) {
      const res = await pageFetch.call(window, '/_next/data/' + build + path + '.json' + (city ? '?region=' + city : ''), { headers: { 'x-nextjs-data': '1' } });
      if (res.status === 404) throw new Error('Partiful has no explore page for ' + (city || 'the default place'));
      if (res.status === 429) throw Object.assign(new Error('Partiful answered 429'), { status: 429 });
      if (res.ok) {
        try {
          const j = await res.json();
          if (j && j.pageProps) return trim(j.pageProps, 0);
        } catch (e) {}
      }
    }
    // The page itself, server-rendered, as a fresh visit gets it.
    const res = await pageFetch.call(window, path, { credentials: 'include' });
    if (res.status === 404) throw new Error('Partiful has no explore page for ' + (city || 'the default place'));
    if (!res.ok) throw Object.assign(new Error('Partiful answered ' + res.status), { status: res.status });
    const html = await res.text();
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error('the explore page carried no data');
    const d = JSON.parse(m[1]);
    return trim(d && d.props && d.props.pageProps, 0);
  }

  // ------------------------------------------------------------ Stream
  let stream = null; // { token, user, at }: never sent anywhere but Stream
  function jwtUser(t) {
    try {
      const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const j = JSON.parse(atob(p + '==='.slice((p.length + 3) % 4)));
      return typeof j.user_id === 'string' ? j.user_id : null;
    } catch (e) {
      return null;
    }
  }
  async function streamAuth(fresh) {
    if (stream && !fresh && Date.now() - stream.at < 45 * 60000) return stream;
    const r = await fn('getStreamUserToken', {}, undefined, { signedIn: true });
    const token = r.data && typeof r.data.token === 'string' ? r.data.token : null;
    const user = token && jwtUser(token);
    if (!token || !user) throw new Error('Partiful gave no chat sign-in');
    stream = { token, user, at: Date.now() };
    return stream;
  }
  /** One Stream REST call as the app's Stream client makes it, signed with the page's chat token. */
  async function sc(method, path, json, again) {
    const s = await streamAuth(false);
    const q = '?user_id=' + encodeURIComponent(s.user) + '&api_key=' + STREAM_KEY;
    const init = { method, headers: { Authorization: s.token, 'stream-auth-type': 'jwt', 'X-Stream-Client': STREAM_CLIENT } };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await pageFetch.call(window, streamBase() + path + q, init);
    let body = null;
    try {
      body = await res.json();
    } catch (e) {}
    if (res.status === 401 && !again) {
      stream = null;
      return sc(method, path, json, true);
    }
    if (!res.ok) throw Object.assign(new Error('Partiful chat answered ' + res.status + (body && body.message ? ': ' + String(body.message).slice(0, 160) : '')), { status: res.status });
    return body;
  }

  const MEDIA = /^(firebasestorage\.googleapis\.com|storage\.googleapis\.com|assets\.partiful\.com|[a-z0-9-]+\.stream-io-cdn\.com)$/;
  async function media(u) {
    let url;
    try {
      url = new URL(String(u));
    } catch (e) {
      throw new Error('not a picture address');
    }
    const test = settings.testOrigin && String(u).indexOf(settings.testOrigin + '/') === 0;
    if (!test && !(url.protocol === 'https:' && MEDIA.test(url.hostname))) throw new Error('refusing a picture from outside Partiful');
    // As an <img> loads it: no cookies off the site.
    const res = await pageFetch.call(window, url.href, test ? {} : { credentials: 'omit' });
    if (!res.ok) throw new Error('picture answered ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) throw new Error('picture too large');
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { mime: res.headers.get('content-type') || 'application/octet-stream', base64: btoa(bin) };
  }

  // Writes one at a time, in the order asked.
  let chain = Promise.resolve();
  const serial = (f) => {
    const r = chain.then(f, f);
    chain = r.catch(() => {});
    return r;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const zone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      return undefined;
    }
  };

  /**
   * Every call this hook makes. Reads: Explore, an event, its guests (shown lists only), mutual guests, comments, host
   * messages, album, your events, notifications, people, chats. Writes: a comment, a reaction on a comment or a host
   * message, an RSVP, a chat message, a chat reaction, a chat's read mark.
   */
  const CALLS = {
    explore: (c) => explore(c),
    event: (c) => fn('getEventInfo', { eventId: id(c.id, 'event') }),
    guests: (c) => fn('getGuests', { eventId: id(c.id, 'event'), includeInvitedGuests: true }, { cursor: cursor(c.cursor), maxResults: 500 }).then(withoutRsvpDetail),
    mutualGuests: (c) => fn('getMutualGuests', { eventId: id(c.id, 'event') }, undefined, { signedIn: true }),
    comments: (c) => fn('getEventComments', { eventId: id(c.id, 'event') }),
    hostMessages: (c) => fn('getEventDisplayedHostMessages', { eventId: id(c.id, 'event') }),
    album: (c) => fn('getEventMedia', { eventId: id(c.id, 'event') }),
    myEvents: () => fn('getMyUpcomingEventsForHomePage', {}, undefined, { signedIn: true }),
    notifications: (c) => {
      const after = c.startAfterMs === undefined ? undefined : Number.isFinite(c.startAfterMs) && c.startAfterMs > 0 ? c.startAfterMs : bad('a time');
      return fn('getNotifications', { cursor: { startAfterMs: after, startId: after === undefined ? undefined : cid(c.startId, 'notification') } }, undefined, { signedIn: true });
    },
    users: (c) => {
      const ids = Array.isArray(c.ids) && c.ids.length && c.ids.length <= 100 ? c.ids.map((x) => id(x, 'user')) : bad('people to look up');
      return fn('getUsers', { ids, includePartyStats: true });
    },
    comment: (c) =>
      serial(() =>
        fn('createComment', { id: uuid(), eventId: id(c.event, 'event'), message: text(c.text, 5000), replyTo: c.replyTo === undefined ? undefined : cid(c.replyTo, 'comment'), timezone: zone(), mentions: [] }, undefined, { signedIn: true }),
      ),
    commentReaction: (c) => serial(() => fn('updateCommentReaction', { eventId: id(c.event, 'event'), commentId: cid(c.comment, 'comment'), reaction: { emoji: text(c.emoji, 32), active: !c.remove } }, undefined, { signedIn: true })),
    hostMessageReaction: (c) =>
      serial(() => fn('updateHostMessageReaction', { eventId: id(c.event, 'event'), hostMessageId: cid(c.message, 'message'), reaction: { emoji: text(c.emoji, 32), active: !c.remove } }, undefined, { signedIn: true })),
    rsvp: (c) => {
      const status = ['GOING', 'MAYBE', 'DECLINED', 'INTERESTED'].indexOf(c.status) >= 0 ? c.status : bad('an RSVP');
      const note = c.note === undefined || c.note === null || c.note === '' ? undefined : text(c.note, 500);
      return serial(() => fn('addGuest', { eventId: id(c.event, 'event'), rsvp: { status, count: 1, message: note, guestId: c.guestId === undefined ? undefined : id(c.guestId, 'guest') } }, undefined, { signedIn: true }));
    },
    chatSelf: () => streamAuth(false).then((s) => ({ user: s.user })),
    chats: (c) => {
      const offset = c.offset === undefined ? 0 : Number.isInteger(c.offset) && c.offset >= 0 && c.offset < 1000 ? c.offset : bad('an offset');
      return streamAuth(false).then((s) =>
        sc('POST', '/channels', { filter_conditions: { type: 'messaging', members: { $in: [s.user] } }, sort: [{ field: 'last_message_at', direction: -1 }], state: true, watch: false, presence: false, limit: 30, offset, message_limit: 25 }),
      );
    },
    chat: (c) => {
      const before = c.before === undefined ? undefined : /^[\w-]{1,128}$/.test(String(c.before)) ? String(c.before) : bad('a message id');
      const limit = Number.isInteger(c.limit) && c.limit > 0 && c.limit <= 100 ? c.limit : 50;
      return sc('POST', '/channels/messaging/' + sid(c.id) + '/query', { state: true, watch: false, presence: false, messages: before ? { limit, id_lt: before } : { limit } });
    },
    chatSend: (c) =>
      serial(() =>
        streamAuth(false).then((s) =>
          sc('POST', '/channels/messaging/' + sid(c.id) + '/message', { message: { id: s.user + '-' + uuid(), text: text(c.text, 5000), ...(c.replyTo ? { quoted_message_id: /^[\w-]{1,128}$/.test(c.replyTo) ? c.replyTo : bad('a message id') } : {}) } }),
        ),
      ),
    chatReact: (c) =>
      serial(() => {
        const msg = /^[\w-]{1,128}$/.test(String(c.message)) ? String(c.message) : bad('a message id');
        const type = typeof c.type === 'string' && c.type.length && c.type.length <= 32 ? c.type : bad('a reaction');
        return c.remove ? sc('DELETE', '/messages/' + msg + '/reaction/' + encodeURIComponent(type)) : sc('POST', '/messages/' + msg + '/reaction', { reaction: { type }, enforce_unique: false });
      }),
    chatRead: (c) => serial(() => sc('POST', '/channels/messaging/' + sid(c.id) + '/read', {})),
    media: (c) => media(c.url),
    self: async () => ({ state: await pageState(), self: lastAuth ? { id: lastAuth.uid, name: lastAuth.name } : null, path: location.pathname.slice(0, 200), version: HOOK_VERSION }),
  };

  async function runCommand(cmd) {
    const f = Object.prototype.hasOwnProperty.call(CALLS, cmd.kind) ? CALLS[cmd.kind] : null;
    if (!f) throw new Error('unknown command ' + cmd.kind);
    return f(cmd);
  }

  cloak.onDown((payload) => {
    if (payload.t === 'settings') {
      Object.assign(settings, payload.settings || {});
      return;
    }
    if (payload.t !== 'cmd') return;
    const done = watch.take(payload);
    if (!done) return;
    Promise.resolve()
      .then(() => runCommand(payload.cmd || {}))
      .then((result) => post({ t: 'reply', id: payload.id, ok: true, result }))
      .catch((err) => post({ t: 'reply', id: payload.id, ok: false, error: String((err && err.message) || err).slice(0, 300), ...(err && err.status ? { status: err.status } : {}) }))
      .finally(done);
  });

  post({ t: 'hook', version: HOOK_VERSION, path: location.pathname.slice(0, 200) });
  const loaded = () => {
    loadedAt = Date.now();
    void reportPage();
  };
  if (document.readyState === 'complete') loaded();
  else window.addEventListener('load', loaded);
  setInterval(() => void reportPage(), 3000);
  log('info', 'hook ' + HOOK_VERSION + ' installed');
})();
