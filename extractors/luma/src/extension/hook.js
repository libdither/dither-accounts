/*
 * MAIN-world content script on luma.com, at document_start. luma.com is Luma's web app (Next.js, built with
 * Turbopack), and everything it shows comes from JSON calls to its API, https://api.luma.com, made by one client class
 * with the session cookie (`credentials: 'include'`): a GET with the arguments as a query string (null and undefined
 * left out), a POST with a JSON body, and the headers its `getCustomHeaders` adds (`x-luma-client-type: luma-web`,
 * `x-luma-client-version`, `x-luma-web-url`, `x-luma-timezone`, `x-luma-document-referrer`, `x-luma-previous-path`,
 * `accept-language`). docs/luma.md lists the calls and where in the bundle each was read.
 *
 * This hook makes only those calls, each as the web app makes it for the same click, from a fixed list (CALLS below):
 * nothing here builds a path from what the extractor sends beyond an id or a cursor, checked first. It never calls
 * what marks something seen (/notifications/mark-as-read), nor anything that signs in, pays or sends without the
 * extractor asking for exactly that.
 *
 * The client version is the build's own: it is read off the page's own calls to the API as they go by (a wrapper of
 * fetch that only looks at the headers), and left out until one has.
 *
 * What it says on its own: who is signed in (GET /user, as the page's server asks on every load), whether the page is
 * a Cloudflare check, and which page it is on. Plain JS on purpose (no build step).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  /*@include command-watch@*/
  if (!cloak.once()) return;
  const HOOK_VERSION = 1;
  const settings = { testOrigin: null };
  // No call at all before the worker has said where the API is (a test's fake, or Luma's own).
  let settingsReady = false;
  // The page's fetch as it was at document_start, before any of its scripts ran.
  const nativeFetch = window.fetch;

  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg: String(msg).slice(0, 300) });
  const watch = commandWatch({ post, log });
  const api = () => settings.testOrigin || 'https://api.luma.com';

  // ------------------------------------------------------------------ the page's own headers
  const learned = { version: null, previous: null };
  function headerList(h) {
    const out = [];
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => out.push([String(k).toLowerCase(), String(v)]));
      else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out.push([String(k).toLowerCase(), String(v)]);
    } catch (e) {}
    return out;
  }
  function noteCall(input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (!url || !String(url).startsWith(api() + '/')) return;
      for (const [k, v] of headerList((init && init.headers) || (input && input.headers))) {
        if (k === 'x-luma-client-version' && /^[\w:.|-]{1,80}$/.test(v)) learned.version = v;
        if (k === 'x-luma-previous-path' && v.length < 300) learned.previous = v;
      }
    } catch (e) {}
  }
  const fetchWrapper = {
    fetch(input, init) {
      noteCall(input, init);
      return cloak.apply(nativeFetch, this, arguments);
    },
  }.fetch;
  cloak.replace(window, 'fetch', () => fetchWrapper);

  function timezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }
  /** The headers Luma's web client sends with every call (its getCustomHeaders, empty ones left out). */
  function headers(json) {
    const h = {
      'accept-language': (navigator.languages && navigator.languages.join(',')) || navigator.language || '',
      'x-luma-client-version': learned.version || '',
      'x-luma-web-url': location.origin + location.pathname,
      'x-luma-previous-path': learned.previous || '',
      'x-luma-document-referrer': document.referrer || '',
      'x-luma-timezone': timezone(),
      'x-luma-client-type': 'luma-web',
    };
    for (const k of Object.keys(h)) if (!h[k]) delete h[k];
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** The client's query string: entries in the given order, null and undefined left out. */
  function withQuery(path, query) {
    const parts = [];
    for (const k of Object.keys(query || {})) {
      const v = query[k];
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? path + '?' + parts.join('&') : path;
  }

  /**
   * One call as Luma's client makes it; its JSON, or an Error in Luma's words. A 429 says so (the extractor backs off);
   * a Cloudflare check (its `cf-mitigated: challenge`, or an HTML page where JSON was due) is `challenge`.
   */
  async function call(method, path, query, json) {
    const init = { method, credentials: 'include', headers: headers(json !== undefined) };
    if (json !== undefined) init.body = JSON.stringify(json);
    const res = await cloak.apply(nativeFetch, window, [api() + (method === 'GET' ? withQuery(path, query) : path), init]);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const cf = (res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge';
    let body = null;
    if (type.includes('json')) {
      try {
        body = await res.json();
      } catch (e) {}
    }
    if (cf || (!res.ok && type.includes('text/html') && (res.status === 403 || res.status === 503))) {
      const e = new Error('Luma answered ' + res.status + ': a Cloudflare check (challenge)');
      e.status = res.status;
      throw e;
    }
    if (!res.ok) {
      const said = body && (typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null);
      const code = body && typeof body.code === 'string' ? ' [' + body.code.slice(0, 60) + ']' : '';
      const e = new Error('Luma answered ' + res.status + code + (said ? ': ' + String(said).slice(0, 160) : ''));
      e.status = res.status;
      throw e;
    }
    return body;
  }

  // ------------------------------------------------------------------ the page
  let me = undefined; // undefined: not asked yet; null: signed out
  let meAt = 0;
  let lastPage = '';
  function challenged() {
    try {
      return /^Just a moment|^Attention Required/.test(document.title || '') || !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile-wrapper');
    } catch (e) {
      return false;
    }
  }
  /** Who is signed in: GET /user, as the page's server asks on every load. Asked again on a new page, else every 10 minutes. */
  let mePath = '';
  async function self(force) {
    if (!force && me !== undefined && mePath === location.pathname && Date.now() - meAt < 600000) return me;
    mePath = location.pathname;
    try {
      const r = await call('GET', '/user', {});
      const u = r && r.user;
      me = u && typeof u.api_id === 'string' ? { api_id: u.api_id, name: typeof u.name === 'string' ? u.name : null, username: typeof u.username === 'string' ? u.username : null, avatar_url: typeof u.avatar_url === 'string' ? u.avatar_url : null } : null;
    } catch (e) {
      if (e.status === 401 || e.status === 403) me = null;
      else throw e;
    }
    meAt = Date.now();
    return me;
  }
  function pageState() {
    if (challenged()) return 'challenge';
    if (document.readyState === 'loading' || me === undefined) return 'loading';
    return me ? 'ready' : 'login';
  }
  async function reportPage() {
    if (!settingsReady) return;
    if (!challenged() && document.readyState !== 'loading') {
      try {
        await self(false);
      } catch (e) {}
    }
    const state = pageState();
    const s = JSON.stringify([state, location.pathname, me && me.api_id]);
    if (s === lastPage) return;
    lastPage = s;
    post({ t: 'page', state, path: location.pathname.slice(0, 200), self: me || null });
  }

  // ------------------------------------------------------------------ calls
  const ID = (prefix) => new RegExp('^' + prefix + '-[A-Za-z0-9]{1,60}$');
  const ANY = /^[a-z]{2,16}-[A-Za-z0-9]{1,60}$/;
  const CURSOR = /^[\w\-.:=+/%]{1,2000}$/;
  const id = (v, prefix, what) => {
    const s = String(v);
    if (!(prefix ? ID(prefix) : ANY).test(s)) throw new Error('not a Luma ' + what + ' id');
    return s;
  };
  const cursor = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !CURSOR.test(v)) throw new Error('not a Luma cursor');
    return v;
  };
  const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
  const EMOJI = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{0,16}$/u;

  // Writes one at a time, in the order asked.
  let chain = Promise.resolve();
  const serial = (f) => {
    const r = chain.then(f, f);
    chain = r.catch(() => {});
    return r;
  };
  /** A message id as the chat's composer makes one: "chatmsg-" and 12 letters or digits. */
  function messageId() {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += abc[x % abc.length];
    return 'chatmsg-' + s;
  }

  const MEDIA_HOSTS = /^(images\.lumacdn\.com|cdn\.lu\.ma|social-images\.lu\.ma|images\.lu\.ma)$/;
  async function media(u) {
    let url;
    try {
      url = new URL(String(u));
    } catch (e) {
      throw new Error('not a picture address');
    }
    const test = settings.testOrigin && String(u).startsWith(settings.testOrigin + '/');
    if (!test && !(url.protocol === 'https:' && MEDIA_HOSTS.test(url.hostname))) throw new Error('refusing a picture from outside Luma');
    // As an <img> loads it: no cookies off the site.
    const res = await cloak.apply(nativeFetch, window, [url.href, test ? {} : { credentials: 'omit' }]);
    if (!res.ok) throw new Error('picture answered ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) throw new Error('picture too large');
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { mime: res.headers.get('content-type') || 'application/octet-stream', base64: btoa(bin) };
  }

  const needMe = () => {
    if (!me) throw new Error('Luma is not signed in (live view)');
  };

  /**
   * Every call this hook makes. Signed out too: the discover pages (a city, Luma's own pick, their events), an event's
   * page, a profile. Signed in: your events (home), notifications, an event's blasts and guest list, the chat's sync and
   * history. Writes: a chat message, a chat's read mark, a reaction and its removal, registering (one click) and
   * declining.
   */
  const CALLS = {
    // /discover: Luma's pick of a city for this viewer, the places and categories.
    bootstrap: () => call('GET', '/discover/bootstrap-page', {}),
    // A city's page by its slug (luma.com/sf): { kind: 'discover-place', data: { place, events } }.
    place: (c) => {
      const s = String(c.slug || '');
      if (!SLUG.test(s)) throw new Error('not a Luma place');
      return call('GET', '/url', { url: s });
    },
    // A city's events, as its page pages them (25 a page).
    discover: (c) => call('GET', '/discover/get-paginated-events', { discover_place_api_id: id(c.place, 'discplace', 'place'), pagination_cursor: cursor(c.cursor), pagination_limit: 25 }),
    event: (c) => call('GET', '/event/get', { event_api_id: id(c.id, 'evt', 'event') }),
    profile: (c) => call('GET', '/user/profile', { username: id(c.id, 'usr', 'user') }),
    profileEvents: (c) => call('GET', '/user/profile/events', { username: id(c.id, 'usr', 'user') }),
    // Signed in: Home's Events tab, upcoming or past.
    myEvents: (c) => (needMe(), call('GET', '/home/get-events', { period: c.period === 'past' ? 'past' : 'future', pagination_cursor: cursor(c.cursor), pagination_limit: 25 })),
    notifications: (c) => (needMe(), call('GET', '/notifications/list', { pagination_cursor: cursor(c.cursor) })),
    blasts: (c) => (needMe(), call('GET', '/event/get-blasts', { event_api_id: id(c.id, 'evt', 'event') })),
    // The guest list's dialog: only for an event whose host shows the list (the extractor asks only then).
    guests: (c) =>
      (needMe(),
      call('GET', '/event/get-guest-list', { event_api_id: id(c.id, 'evt', 'event'), ticket_key: c.ticketKey === undefined || c.ticketKey === null ? undefined : String(c.ticketKey).slice(0, 80), pagination_cursor: cursor(c.cursor), pagination_limit: 100 })),
    calendarUrls: (c) => (needMe(), call('GET', '/event/get-calendar-urls', { event_api_id: id(c.id, 'evt', 'event'), proxy_key: c.proxyKey === undefined || c.proxyKey === null ? undefined : String(c.proxyKey).slice(0, 120) })),
    // The chat's own sync, as its page runs it on load: conversations, then messages (250 the first page, 50 after).
    convSync: (c) => (needMe(), call('GET', '/chat/conversations/sync', { pagination_cursor: cursor(c.cursor) })),
    msgSync: (c) => (needMe(), call('GET', '/chat/messages/sync', { pagination_cursor: cursor(c.cursor), pagination_limit: c.first ? 250 : 50 })),
    conversation: (c) => (needMe(), call('GET', '/chat/conversation/get', { chat_conversation_api_id: id(c.id, null, 'chat') })),
    messages: (c) => (needMe(), call('GET', '/chat/conversation/get-messages', { chat_conversation_api_id: id(c.id, null, 'chat'), sort_column: 'sent_at', pagination_cursor: cursor(c.cursor) })),
    send: (c) =>
      serial(() => {
        needMe();
        if (typeof c.text !== 'string' || !c.text.trim()) throw new Error('nothing to send');
        return call('POST', '/chat/conversation/send', undefined, {
          chat_conversation_api_id: id(c.id, null, 'chat'),
          replying_to_message_api_id: c.replyTo === undefined || c.replyTo === null ? null : id(c.replyTo, null, 'message'),
          message_api_id: messageId(),
          message: c.text,
        });
      }),
    markRead: (c) => serial(() => (needMe(), call('POST', '/chat/conversation/mark-as-read', undefined, { chat_conversation_api_id: id(c.id, null, 'chat') }))),
    react: (c) =>
      serial(() => {
        needMe();
        const m = id(c.message, null, 'message');
        if (c.remove) return call('POST', '/chat/conversation/remove-reaction', undefined, { chat_message_api_id: m });
        if (typeof c.key !== 'string' || !EMOJI.test(c.key)) throw new Error('not an emoji');
        return call('POST', '/chat/conversation/add-reaction', undefined, { chat_message_api_id: m, reaction_type: c.key });
      }),
    // The event page's one-click Register: a free event, one ticket type, no questions (the extractor checks first).
    register: (c) =>
      serial(async () => {
        if (!me) throw new Error('Luma is not signed in (live view)');
        const ev = id(c.id, 'evt', 'event');
        const full = await call('GET', '/user', {});
        const u = (full && full.user) || {};
        const t = c.ticketType ? id(c.ticketType, 'ttype', 'ticket type') : null;
        return call('POST', '/event/register', undefined, {
          coupon_code: null,
          currency: null,
          email: typeof u.email === 'string' ? u.email : null,
          eth_address_info: null,
          event_api_id: ev,
          payment_method: null,
          phone_number: null,
          ticket_type_to_selection: t ? { [t]: { count: 1, amount: 0 } } : {},
          expected_amount_cents: 0,
          expected_amount_tax: 0,
          for_waitlist: !!c.waitlist,
          name: typeof u.name === 'string' ? u.name : '',
          first_name: typeof u.first_name === 'string' ? u.first_name : null,
          last_name: typeof u.last_name === 'string' ? u.last_name : null,
          event_invite_api_id: c.invite ? id(c.invite, null, 'invite') : null,
          payment_method_id: null,
          registration_answers: [],
          opened_from: null,
          solana_address_info: null,
          token_gate_info: null,
          payment_currency: null,
        });
      }),
    // "Not going" (an invite) or Cancel Registration: the same call, with your note or null.
    decline: (c) =>
      serial(() => {
        needMe();
        const note = typeof c.note === 'string' && c.note.trim() ? c.note.trim().slice(0, 1000) : null;
        return call('POST', '/event/decline-my-registration', undefined, { event_api_id: id(c.id, 'evt', 'event'), decline_message: note, ...(c.invite ? { invite_secret_key: String(c.invite).slice(0, 120) } : {}) });
      }),
    media: (c) => media(c.url),
    self: async () => {
      await self(true).catch(() => {});
      return { state: pageState(), self: me || null, path: location.pathname.slice(0, 200), version: HOOK_VERSION };
    },
  };

  async function runCommand(cmd) {
    const f = Object.prototype.hasOwnProperty.call(CALLS, cmd.kind) ? CALLS[cmd.kind] : null;
    if (!f) throw new Error('unknown command ' + cmd.kind);
    if (!settingsReady) throw new Error('the page has not had its settings yet');
    if (challenged() && cmd.kind !== 'self') throw new Error('Luma answered 403: a Cloudflare check (challenge)');
    return f(cmd);
  }

  cloak.onDown((payload) => {
    if (payload.t === 'settings') {
      Object.assign(settings, payload.settings || {});
      settingsReady = true;
      me = undefined;
      void reportPage();
      return;
    }
    if (payload.t !== 'cmd') return;
    const done = watch.take(payload);
    if (!done) return;
    Promise.resolve()
      .then(() => runCommand(payload.cmd || {}))
      .then((result) => post({ t: 'reply', id: payload.id, ok: true, result }))
      .catch((err) => post({ t: 'reply', id: payload.id, ok: false, error: String((err && err.message) || err).slice(0, 300) }))
      .finally(done);
  });

  post({ t: 'hook', version: HOOK_VERSION, path: location.pathname.slice(0, 200) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void reportPage());
  else void reportPage();
  setInterval(() => void reportPage(), 3000);
  log('info', 'hook ' + HOOK_VERSION + ' installed');
})();
