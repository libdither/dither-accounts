/*
 * MAIN-world content script on calendar.google.com and mail.google.com, at document_start. Never injected into
 * accounts.google.com. The same hook runs in both pages; each says which page it is in (its role, 'calendar' or
 * 'gmail', from location.host) when it comes up, and the service worker sends each page only its own commands.
 *
 * It (a) watches the page's own requests to Google (fetch and XMLHttpRequest) and keeps only their host, a path
 * template with ids taken out, the `key=` API key, and the shape of their Authorization (which schemes, whether the
 * hashes end in `_u`): never bodies, responses, header values or cookie values; (b) looks for API keys in the page's
 * HTML once; (c) answers `gfetch`, a call to a Google API made as the page makes them: its cookies (credentials
 * include) and a SAPISIDHASH Authorization worked out from the SAPISID cookies, which leave the page only as hashes;
 * (d) says whether the page is signed in (the SAPISID cookie is there) and, if the page shows it, as whom.
 *
 * In the Gmail page only, it also (e) records the SHAPE of the page's own calls to its own origin (fetch and
 * XMLHttpRequest): for each method and path template, a count and up to 6 samples of status, media type and the
 * request's and response's shapes, in which every value is a type tag ('e', 'd', 's<100', …) and only anchors (system
 * label ids, the kind of a thread or message id, header names) are kept (the learn block below, the same as
 * ../gmail-learn.js); and (f) answers the steering commands of a learn run (docs/google.md, "Learning Gmail's
 * protocol"): gmail.nav (a few views, or a search of operators only, checked here again), gmail.openRead (a click on a
 * row the list shows as read, never an unread or uncertain one), gmail.back and gmail.shapes.
 *
 * And in the Gmail page, for reading mail (docs/google.md, "Gmail mail"): (g) it notes what the page's own calls to
 * its sync endpoints (/sync/u/<n>/i/…) carry, the latest of each and only here in the page: their headers (names and
 * values), the query's hl, rt and pt and the highest c, the sync point (history id) the page's own s calls start
 * from, and the account key (ik) its /mail/u/<n>/ calls carry; (h) it answers gmail.sync, a POST to bv, fd or s made
 * as the page makes them (its headers replayed, the next c), refusing an s body that carries label changes, so it
 * only reads; gmail.raw, the page's own "Download message" route (view=att&disp=comp) for one message, kept here and
 * handed over in pieces (gmail.rawChunk, gmail.rawDrop); and gmail.syncInfo (what is known: counts and yes/no, the
 * sync point, never a header's value or the key). An answer to either that is not what was asked for (not JSON, an
 * HTML page, a 429) goes up only as what it reads as (pageKind: a sign-in or verification page, or neither). (i) For
 * writing (docs/google.md, "Writing to Gmail"): gmail.write, an s call that is one of the page's own kinds of write
 * (label changes from a fixed set, a draft and its send; writeRefusal says why any other is refused), and
 * gmail.upload, an attachment handed over in pieces (gmail.uploadChunk) and uploaded as the page uploads one.
 *
 * It never sees the extractor's token; it only talks to content.js, over the channel in main-world.js (put in below
 * when the extension is copied), which also keeps its fetch and XMLHttpRequest wrappers looking native to the page.
 * Plain JS on purpose.
 */
(() => {
  'use strict';
  /*@include main-world@*/
  /* learn:begin (one text in two files, extension/hook.js and gmail-learn.js; test/gmail-learn.test.ts keeps them equal) */
  const learn = (() => {
    /** Header names, kept as they are (compared without case): what mail is made of, never a value. */
    const HEADERS = ['message-id', 'in-reply-to', 'references', 'from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'content-type', 'delivered-to', 'return-path', 'x-gmail-labels'];
    /** Gmail's system label ids (^i, ^all, ^smartlabel_social): kept. */
    const LABEL = /^\^[a-z0-9_]{1,24}$/;
    /** Thread and message ids: kept as their kind (id:thread-f), never the number. */
    const ID = /^(thread-f|msg-f|thread-a|msg-a):[A-Za-z0-9_-]{1,64}$/;
    /** Object keys kept; any other key is k*. */
    const KEY = /^[A-Za-z_][\w.-]{0,40}$/;
    const H16 = /^[0-9a-f]{16}$/;
    const DIGITS = /^\d+$/;
    const ISO = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:?\d\d)?)?$/;
    const URLISH = /^(?:https?:)?\/\/\S+$/i;
    const B64 = /^[A-Za-z0-9+/_-]{20,}={0,2}$/;
    /** Google's anti-XSSI prefixes: )]}' and the rest of its line, while(1); and for(;;);. */
    const XSSI = /^\s*(?:\)\]\}'[^\n]*(?:\n|$)|while\s*\(\s*1\s*\)\s*;|for\s*\(\s*;\s*;\s*\)\s*;)/;
    const FORMISH = /^[\w.%*-]+=[^&]*(?:&[\w.%*-]+=[^&]*)*$/;
    /** Containers this deep become '…'. */
    const DEPTH = 20;
    /** Elements of an array kept, by position; a longer array adds 'len:<bucket>'. */
    const WIDE = 40;
    /** Keys of one object (or form) kept; more add 'k#': 'len:<bucket>'. */
    const KEYS = 48;
    const OPS = ['in', 'is', 'label', 'has', 'after', 'before', 'older_than', 'newer_than', 'category', 'larger', 'smaller'];
    const VIEWS = ['#inbox', '#all', '#starred', '#sent'];
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    const bucket = (n) => (n === 0 ? '0' : n < 10 ? '<10' : n < 100 ? '<100' : n < 1000 ? '<1k' : '1k+');
    const keyOf = (k) => (KEY.test(k) && k !== '__proto__' ? k : 'k*');

    /** A string's type tag, or the string itself when it is an anchor. */
    function str(s) {
      if (LABEL.test(s)) return s;
      const id = ID.exec(s);
      if (id) return 'id:' + id[1];
      if (s.length <= 24 && HEADERS.indexOf(s.toLowerCase()) >= 0) return s;
      if (s.indexOf('@') >= 0 && s.length <= 320) return 'e';
      if (H16.test(s)) return 'h16';
      if (DIGITS.test(s)) return 'd';
      if (ISO.test(s)) return 'ts';
      if (URLISH.test(s)) return 'url';
      if (B64.test(s)) return 'b64';
      return 's' + bucket(s.length);
    }

    /** Small whole numbers (positional enums) as they are; times by their unit; the rest 'n'. */
    function num(n) {
      if (!Number.isInteger(n)) return 'n';
      if (n >= 0 && n <= 64) return n;
      if (n >= 1e12 && n < 1e13) return 'n:ms';
      if (n >= 1e9 && n < 1e10) return 'n:s';
      return 'n';
    }

    function walk(v, depth) {
      if (v === null || v === undefined) return null;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return num(v);
      if (typeof v === 'string') return str(v);
      if (typeof v !== 'object') return null;
      if (depth >= DEPTH) return '…';
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length && i < WIDE; i++) out.push(walk(v[i], depth + 1));
        if (v.length > WIDE) out.push('len:' + bucket(v.length));
        return out;
      }
      const out = {};
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length && i < KEYS; i++) {
        const k = keyOf(keys[i]);
        if (!hasOwn(out, k)) out[k] = walk(v[keys[i]], depth + 1);
      }
      if (keys.length > KEYS) out['k#'] = 'len:' + bucket(keys.length);
      return out;
    }

    /** A value's shape: type tags and anchors only, never a value. */
    const shape = (v) => walk(v, 0);

    /** A form or query value: its JSON's shape when it is JSON, else a string's tag. */
    function value(v) {
      try {
        return shape(JSON.parse(v));
      } catch (e) {
        return str(v);
      }
    }

    /** A form-encoded body (or a query): each key as an object's, each value JSON when it parses. */
    function form(text) {
      const out = {};
      let n = 0;
      new URLSearchParams(text).forEach((v, k) => {
        if (++n > KEYS) return;
        const key = keyOf(k);
        if (!hasOwn(out, key)) out[key] = value(v);
      });
      if (n > KEYS) out['k#'] = 'len:' + bucket(n);
      return out;
    }

    /** JSON after an XSSI prefix, or Google's length-prefixed chunks (one JSON per line); null if neither. */
    function parse(text) {
      const t = text.replace(XSSI, '');
      try {
        return { json: JSON.parse(t) };
      } catch (e) {}
      const chunks = [];
      const lines = t.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l || DIGITS.test(l)) continue;
        try {
          chunks.push(JSON.parse(l));
        } catch (e) {
          return null;
        }
      }
      return chunks.length ? { chunks } : null;
    }

    /**
     * A body's shape: { json } (after an XSSI prefix), { chunks }, { form } (form-encoded: by its type, a
     * URLSearchParams, or how it reads), { multipart }, { binary: <size bucket> }, or { text: <length bucket> }.
     */
    function shapeBody(body, type) {
      if (body === null || body === undefined) return null;
      if (typeof body !== 'string') {
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { form: form(String(body)) };
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
          const out = {};
          let n = 0;
          body.forEach((v, k) => {
            if (++n <= KEYS && !hasOwn(out, keyOf(k))) out[keyOf(k)] = typeof v === 'string' ? value(v) : 'file';
          });
          return { multipart: out };
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob) return { binary: bucket(body.size) };
        if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return { binary: bucket(body.byteLength) };
        if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return { binary: 'stream' };
        return { json: shape(body) }; // already parsed (an XMLHttpRequest's responseType 'json')
      }
      const formType = /x-www-form-urlencoded/i.test(String(type || ''));
      if (!formType) {
        const j = parse(body);
        if (j && j.chunks) {
          const out = [];
          for (let i = 0; i < j.chunks.length && i < WIDE; i++) out.push(shape(j.chunks[i]));
          if (j.chunks.length > WIDE) out.push('len:' + bucket(j.chunks.length));
          return { chunks: out };
        }
        if (j) return { json: shape(j.json) };
      }
      if (formType || FORMISH.test(body)) return { form: form(body) };
      return { text: bucket(body.length) };
    }

    /** A request's shape: its query (as a form) and its body. */
    function requestShape(search, type, body) {
      const out = {};
      const q = String(search || '').replace(/^\?/, '');
      if (q) out.query = form(q);
      if (body !== null && body !== undefined) out.body = shapeBody(body, type);
      return out;
    }

    /** A path with ids and numbers taken out: /sync/u/0/i/bv stays, /mail/u/0/x/abc123/ is /mail/u/0/x/{id}/. */
    function pathTemplate(path) {
      return String(path)
        .split('/')
        .slice(0, 24)
        .map((seg) => {
          if (!seg) return seg;
          let s = seg;
          try {
            s = decodeURIComponent(seg);
          } catch (e) {}
          if (/^\d{1,2}$/.test(s)) return s;
          if (DIGITS.test(s)) return '{n}';
          if (/^[A-Za-z_][A-Za-z_.-]{0,15}$/.test(s)) return s;
          return '{id}';
        })
        .join('/');
    }

    /** A Content-Type's media type, without its parameters. */
    function mediaType(type) {
      const m = /^\s*([\w.+-]+\/[\w.+-]+)/.exec(String(type || ''));
      return m ? m[1].toLowerCase().slice(0, 80) : null;
    }

    /**
     * The hash a `gmail.nav` may set, in Gmail's own form, or an Error saying why not (never what the search held):
     * #inbox, #all, #starred, #sent, or #search/ with operators only (op:value, op one of OPS; no bare words, no quotes).
     */
    function navHash(hash) {
      if (typeof hash !== 'string') throw new Error('nav: the hash is not a string');
      if (VIEWS.indexOf(hash) >= 0) return hash;
      if (hash.slice(0, 8) !== '#search/') throw new Error('nav: only ' + VIEWS.join(', ') + ' and #search/<operators>');
      let q;
      try {
        q = decodeURIComponent(hash.slice(8).replace(/\+/g, ' '));
      } catch (e) {
        throw new Error('nav: the search is not well encoded');
      }
      const tokens = q.split(/\s+/).filter(Boolean);
      if (!tokens.length) throw new Error('nav: the search is empty');
      if (tokens.length > 8) throw new Error('nav: a search holds at most 8 operators');
      for (let i = 0; i < tokens.length; i++) {
        const m = /^([a-z_]+):([A-Za-z0-9_./-]{1,64})$/.exec(tokens[i]);
        if (!m || OPS.indexOf(m[1]) < 0) throw new Error('nav: search word ' + (i + 1) + ' is not an operator (op:value, op one of ' + OPS.join(', ') + ')');
      }
      return '#search/' + tokens.map(encodeURIComponent).join('+');
    }

    /**
     * What an answer from Gmail that is not what was asked for reads as, from its status, media type, text and final
     * address: 'signin' (a sign-in page, or one that ended up on accounts.google.com), 'challenge' (a verification or
     * captcha page, or a 429 that names one), or null. Only the kind, never what the page said: the text stays where it is.
     */
    function pageKind(status, type, text, url) {
      let host = '';
      try {
        host = new URL(String(url || ''), 'https://unknown.invalid/').hostname;
      } catch (e) {}
      if (host === 'accounts.google.com') return 'signin';
      const t = typeof text === 'string' ? text.slice(0, 512 * 1024) : '';
      const challenge = /captcha|unusual (?:traffic|activity)|(?:verify|confirm) (?:that )?it(?:'|&#39;|\u2019)?s (?:really )?you|automated (?:queries|requests)|\/sorry\//i;
      if (status === 429) return challenge.test(t) ? 'challenge' : null;
      if (!/html/i.test(String(type || '')) && !/^\s*<(?:!doctype\s+html|html)/i.test(t)) return null;
      if (challenge.test(t)) return 'challenge';
      if (/accounts\.google\.com|servicelogin|\bsign[ -]?in\b/i.test(t)) return 'signin';
      return null;
    }

    return { shape, shapeBody, requestShape, pathTemplate, mediaType, navHash, pageKind, OPS, VIEWS };
  })();
  /* learn:end */
  const KEY = /AIza[0-9A-Za-z_-]{35}/g;
  const nativeFetch = window.fetch;
  // What the recorder and the steering use, taken now, before the page can replace any of it.
  const PromiseC = Promise;
  const promiseThen = Promise.prototype.then;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatchNative = EventTarget.prototype.dispatchEvent;
  const MouseEv = window.MouseEvent;
  const PointerEv = window.PointerEvent || window.MouseEvent;
  const computed = window.getComputedStyle;
  const later = window.setTimeout;
  const histBack = History.prototype.back;
  const xhrGetter = (name) => {
    const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, name);
    return d && d.get;
  };
  const XG = { status: xhrGetter('status'), responseType: xhrGetter('responseType'), responseText: xhrGetter('responseText'), response: xhrGetter('response') };
  const xhrHeader = XMLHttpRequest.prototype.getResponseHeader;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const fromCharCode = String.fromCharCode;
  const btoaNative = window.btoa;
  let settings = { authuser: '0', testOrigin: null, testMailOrigin: null };

  const post = (payload) => cloak.send(payload);
  const log = (level, msg, data) => post({ t: 'log', level, msg, data });

  const googleHost = (h) => h === 'google.com' || h.endsWith('.google.com') || h === 'googleapis.com' || h.endsWith('.googleapis.com');
  const testOrigin = (o) => (!!settings.testOrigin && o === settings.testOrigin) || (!!settings.testMailOrigin && o === settings.testMailOrigin);

  /** Which page this is: Google's own hosts, or (tests) the origins in the settings; null until it is known. */
  function role() {
    if (location.host === 'mail.google.com') return 'gmail';
    if (location.host === 'calendar.google.com') return 'calendar';
    const mail = settings.testMailOrigin;
    if (mail && location.origin === mail && (mail !== settings.testOrigin || location.pathname.startsWith('/mail/'))) return 'gmail';
    if (settings.testOrigin && location.origin === settings.testOrigin) return 'calendar';
    return null;
  }
  const announce = () => post({ t: 'hook', page: location.origin + location.pathname, role: role() });

  // ------------------------------------------------------------ what the page itself calls
  const endpoints = new Map(); // host + template -> { host, path, keyed, auth }
  const keys = new Map(); // key -> 'calendar-request' | 'gmail-request' | 'page-request' | 'page-html'
  let reportTimer = null;

  /** An id-like path segment: an email, a long token, or anything numeric past a few characters. */
  function idLike(seg) {
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch (e) {}
    return s.includes('@') || s.length > 24 || (/\d/.test(s) && s.length > 4);
  }
  const template = (path) =>
    path
      .split('/')
      .map((s) => (s && idLike(s) ? ':id' : s))
      .join('/');

  /** Which schemes an Authorization value uses, and whether its hashes end in _u. Never the value. */
  function authShape(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    const parts = v.trim().split(/\s+/);
    const schemes = [];
    let u = false;
    for (let i = 0; i < parts.length; i += 2) {
      if (!/^[A-Za-z0-9]{2,32}$/.test(parts[i])) break;
      schemes.push(parts[i]);
      if (/_u$/.test(parts[i + 1] || '')) u = true;
      if (!/HASH$/.test(parts[i])) break; // Bearer and the like: one scheme, then a credential
    }
    return { schemes, u };
  }

  function headerOf(h, name) {
    try {
      if (!h) return null;
      if (typeof h.get === 'function') return h.get(name);
      const entries = Array.isArray(h) ? h : Object.entries(h);
      for (const [k, v] of entries) if (String(k).toLowerCase() === name) return String(v);
    } catch (e) {}
    return null;
  }

  function note(url, auth) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return;
    }
    if (!googleHost(u.hostname) && u.origin !== location.origin && !testOrigin(u.origin)) return;
    const path = template(u.pathname);
    const key = (u.searchParams.get('key') || '').match(/^AIza[0-9A-Za-z_-]{35}$/) ? u.searchParams.get('key') : null;
    const shape = authShape(auth);
    const id = u.host + path;
    const prev = endpoints.get(id);
    const before = prev ? JSON.stringify(prev) : null;
    let changed = false;
    if (!prev && endpoints.size < 300) {
      endpoints.set(id, { host: u.host, path, keyed: !!key, auth: shape });
      changed = true;
    } else if (prev) {
      prev.keyed = prev.keyed || !!key;
      if (shape) prev.auth = shape;
      changed = JSON.stringify(prev) !== before;
    }
    if (key) {
      const source = path.startsWith('/calendar/v3/') ? 'calendar-request' : path.startsWith('/gmail/v1/') ? 'gmail-request' : 'page-request';
      const was = keys.get(key);
      if (was !== 'calendar-request' && was !== 'gmail-request' && was !== source) {
        keys.set(key, source);
        changed = true;
      }
    }
    // A busy page (Gmail polls all the time) says what it calls only when that changes.
    if (changed) report();
  }

  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(sendSeen, 400);
  }
  function sendSeen() {
    post({ t: 'seen', endpoints: [...endpoints.values()], keys: [...keys].map(([key, source]) => ({ key, source })) });
  }

  // ------------------------------------------------------------ the Gmail page's traffic, as shapes
  const LEARN_TEMPLATES = 200; // (method, path template)s kept
  const LEARN_SAMPLES = 6; // distinct samples kept for each
  const LEARN_TRIES = 40; // calls shaped for each, at most: past that, only counted
  const LEARN_BODY_MAX = 4 * 1024 * 1024; // a body longer than this is not read
  const LEARN_SAMPLE_MAX = 256 * 1024; // a sample longer than this keeps no response shape
  const learned = new Map(); // method + ' ' + template -> { method, template, count, tried, samples, seen }
  let learnDropped = 0;
  /** The Gmail page records; until a page knows its role (tests' origins), it records too, and drops it if not Gmail's. */
  const recording = () => {
    const r = role();
    return r === 'gmail' || r === null;
  };
  const textual = (type) => !type || /json|javascript|ecmascript|^\s*text\/(?!event-stream)|xml|x-www-form-urlencoded/i.test(type);
  const quiet = (p) => {
    try {
      cloak.apply(promiseThen, p, [null, () => {}]);
    } catch (e) {}
  };
  const requestOf = (search, type, body) => {
    try {
      return learn.requestShape(search, type, body);
    } catch (e) {
      return { unreadable: true };
    }
  };
  const shapeOf = (body, type) => {
    try {
      return learn.shapeBody(body, type);
    } catch (e) {
      return { unreadable: true };
    }
  };

  /** A call the page makes to its own origin: counted under its template; the context to finish its sample with, if one is wanted. */
  function learnNote(method, url, type, body) {
    let u;
    try {
      u = new URL(String(url), location.href);
    } catch (e) {
      return null;
    }
    if (u.origin !== location.origin) return null;
    const m = typeof method === 'string' && /^[A-Za-z]{1,10}$/.test(method) ? method.toUpperCase() : method ? 'OTHER' : 'GET';
    const template = learn.pathTemplate(u.pathname);
    const id = m + ' ' + template;
    let e = learned.get(id);
    if (!e) {
      if (learned.size >= LEARN_TEMPLATES) {
        learnDropped++;
        return null;
      }
      e = { method: m, template, count: 0, tried: 0, samples: [], seen: new Set() };
      learned.set(id, e);
    }
    e.count++;
    if (e.samples.length >= LEARN_SAMPLES || e.tried >= LEARN_TRIES) return null;
    e.tried++;
    // A Request's body comes as a promise of its text (read from its clone).
    const pending = body instanceof PromiseC ? body : null;
    return { e, search: u.search, type, pending, request: pending ? null : requestOf(u.search, type, body) };
  }

  /** The call's answer is in: its sample, kept if it is one not seen yet for its template. */
  function learnDone(ctx, status, type, response) {
    try {
      if (!recording()) return;
      if (ctx.pending) {
        const p = ctx.pending;
        ctx.pending = null;
        cloak.apply(promiseThen, p, [
          (text) => {
            ctx.request = requestOf(ctx.search, ctx.type, text);
            learnDone(ctx, status, type, response);
          },
          () => {},
        ]);
        return;
      }
      const sample = { status: typeof status === 'number' ? status : null, contentType: learn.mediaType(type), requestShape: ctx.request, responseShape: response };
      let k = JSON.stringify(sample);
      if (k.length > LEARN_SAMPLE_MAX) {
        sample.responseShape = { cut: true };
        k = JSON.stringify(sample);
        if (k.length > LEARN_SAMPLE_MAX) return;
      }
      const e = ctx.e;
      if (e.samples.length >= LEARN_SAMPLES || e.seen.has(k)) return;
      e.seen.add(k);
      e.samples.push(sample);
    } catch (x) {}
  }

  /** A response's text, from a clone, cut off (null) past LEARN_BODY_MAX: the page's own reading is untouched. */
  async function readText(res) {
    const body = res.clone().body;
    if (!body) return '';
    const reader = body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) return text + dec.decode();
      text += dec.decode(r.value, { stream: true });
      if (text.length > LEARN_BODY_MAX) {
        quiet(reader.cancel());
        return null;
      }
    }
  }

  function learnFetchStart(input, init, url) {
    if (!recording()) return null;
    try {
      if (new URL(String(url), location.href).origin !== location.origin) return null;
    } catch (e) {
      return null;
    }
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init && init.method) || (isReq ? input.method : 'GET');
    const type = headerOf(init && init.headers, 'content-type') || (isReq ? input.headers.get('content-type') : null);
    let body = init && init.body !== undefined && init.body !== null ? init.body : null;
    if (body === null && isReq && input.body && !input.bodyUsed) body = cloak.apply(promiseThen, input.clone().text(), [(t) => t, () => null]);
    return learnNote(method, url, type, body);
  }

  function learnFetchEnd(ctx, res) {
    try {
      const status = res.status;
      const type = res.headers.get('content-type');
      if (!status) return learnDone(ctx, status, type, null);
      if (!textual(type)) return learnDone(ctx, status, type, { binary: 'skipped' });
      if (Number(res.headers.get('content-length')) > LEARN_BODY_MAX) return learnDone(ctx, status, type, { cut: true });
      cloak.apply(promiseThen, readText(res), [(text) => learnDone(ctx, status, type, text === null ? { cut: true } : shapeOf(text, type)), () => learnDone(ctx, status, type, null)]);
    } catch (e) {}
  }

  function learnXhrEnd(ctx, x) {
    try {
      const status = cloak.apply(XG.status, x, []);
      const type = cloak.apply(xhrHeader, x, ['content-type']);
      let response = null;
      if (status && !textual(type)) response = { binary: 'skipped' };
      else if (status) {
        const rt = cloak.apply(XG.responseType, x, []);
        if (rt === 'document') response = { binary: 'document' };
        else {
          const body = rt === '' || rt === 'text' ? cloak.apply(XG.responseText, x, []) : cloak.apply(XG.response, x, []);
          response = typeof body === 'string' && body.length > LEARN_BODY_MAX ? { cut: true } : shapeOf(body, type);
        }
      }
      learnDone(ctx, status, type, response);
    } catch (e) {}
  }

  /** gmail.shapes: everything recorded since this page loaded. */
  function shapes() {
    const templates = [];
    learned.forEach((e) => templates.push({ method: e.method, template: e.template, count: e.count, samples: e.samples }));
    return { templates, dropped: learnDropped };
  }

  // ------------------------------------------------------------ the Gmail page's own sync calls, for ours to replay
  /** The latest of each, kept here only: never sent up but as counts and yes/no (the sync point aside). */
  const sync = { seen: false, base: null, headers: null, query: {}, c: 0, history: null, ik: null, mailBase: null };
  const HEADERS_NOT_REPLAYED = ['content-length', 'cookie', 'host', 'origin', 'referer', 'user-agent', 'connection', 'accept-encoding'];

  /** A request's headers as [lower-case name, value] pairs, from a Headers, a list of pairs or a plain object. */
  function headerPairs(h) {
    const out = [];
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => out.push([String(k).toLowerCase(), String(v)]));
      else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out.push([String(k).toLowerCase(), String(v)]);
    } catch (e) {}
    return out.slice(0, 40);
  }

  /** A call of the page's own: a sync call's headers, query and (for s) sync point; a /mail/u/<n>/ call's account key. */
  function syncNote(url, h, body) {
    try {
      if (!recording()) return;
      const u = new URL(String(url), location.href);
      if (u.origin !== location.origin) return;
      const m = /^(\/sync\/u\/\d{1,2}\/i\/)([a-z]{1,8})$/.exec(u.pathname);
      if (m) {
        sync.seen = true;
        sync.base = m[1];
        sync.headers = headerPairs(h).filter((p) => HEADERS_NOT_REPLAYED.indexOf(p[0]) < 0);
        for (const k of ['hl', 'rt', 'pt']) if (u.searchParams.get(k) !== null) sync.query[k] = u.searchParams.get(k);
        const c = Number(u.searchParams.get('c'));
        if (Number.isInteger(c) && c > sync.c) sync.c = c;
        if (m[2] === 's' && typeof body === 'string') {
          const j = jsonParse(body);
          // Only a read's: the page's own writes (label changes, drafts, sends) carry a small number there instead.
          const point = Array.isArray(j) && readOnlySync(j) && Array.isArray(j[3]) ? j[3][4] : null;
          if (typeof point === 'number' && Number.isInteger(point) && point >= 0) sync.history = String(point);
        }
        return;
      }
      const mail = /^(\/mail\/u\/\d{1,2}\/)$/.exec(u.pathname);
      const ik = mail ? u.searchParams.get('ik') : null;
      if (ik && /^[0-9a-f]{6,24}$/i.test(ik)) {
        sync.ik = ik;
        sync.mailBase = mail[1];
      }
    } catch (e) {}
  }

  /** An s body that only reads: nothing where the page puts its label changes (element 1), no list inside element 0. */
  function readOnlySync(body) {
    if (!Array.isArray(body) || (body[1] !== null && body[1] !== undefined)) return false;
    const head = body[0];
    return head === null || head === undefined || (Array.isArray(head) && head.every((x) => x === null || typeof x !== 'object'));
  }

  /** gmail.sync: a POST to the page's own bv, fd or s, with its headers and its query (the next c), the answer's JSON. */
  async function syncCall(endpoint, body) {
    if (['bv', 'fd', 's'].indexOf(endpoint) < 0) throw new Error('gmail.sync: bv, fd or s only');
    if (endpoint === 's' && !readOnlySync(body)) throw new Error('gmail.sync: this s body carries changes; only reads are made here');
    if (!sync.seen || !sync.base) return { status: 0, error: 'no-sync-yet' };
    const q = new URLSearchParams();
    if (sync.query.hl !== undefined) q.set('hl', sync.query.hl);
    q.set('c', String(++sync.c));
    if (sync.query.rt !== undefined) q.set('rt', sync.query.rt);
    if (sync.query.pt !== undefined) q.set('pt', sync.query.pt);
    const headers = {};
    for (const [n, v] of sync.headers || []) headers[n] = v;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    const res = await cloak.apply(nativeFetch, window, [location.origin + sync.base + endpoint + '?' + q.toString(), { method: 'POST', headers, body: jsonStringify(body), credentials: 'include', cache: 'no-store' }]);
    const text = await res.text();
    let json;
    try {
      json = jsonParse(text.replace(/^\s*\)\]\}'[^\n]*(?:\n|$)/, ''));
    } catch (e) {}
    // Not JSON: what it reads as (a sign-in or verification page, or neither), never what it says.
    if (json === undefined) return { status: res.status, error: 'not-json', page: learn.pageKind(res.status, res.headers.get('content-type'), text, res.url) };
    return { status: res.status, json };
  }

  // gmail.write: the page's own kinds of write, and nothing else (write.ts builds them; this checks them again).
  const WRITE_LABEL = /^\^(?:u|us|o|t|ss_[a-z]{2}|i|a|k|s|t_z|ri_hl|iim|t_p|t_rd|afw|pr_i_u|io_re|io_fwd|x_\d{1,24})$/;
  const DRAFT_LABELS = '^all,^r,^r_bt';
  const SENT_LABELS = '^all,^pfg,^f_bt,^f_btns,^f_cl';
  const W_THREAD = /^thread-(?:f:\d{1,20}|a:r-\d{1,20})$/;
  const W_MSG_F = /^msg-f:\d{1,20}$/;
  const W_MSG_A = /^msg-a:r-\d{1,20}$/;
  // A label list to add (never Spam: marking spam is not built) or to take off.
  const labelsOk = (l, adding) => l === null || (Array.isArray(l) && l.length > 0 && l.length <= 24 && l.every((x) => typeof x === 'string' && WRITE_LABEL.test(x) && !(adding && x === '^s')));
  const recordOk = (r, sending) => Array.isArray(r) && r.length === 78 && typeof r[0] === 'string' && W_MSG_A.test(r[0]) && Array.isArray(r[10]) && r[10].join(',') === (sending ? SENT_LABELS : DRAFT_LABELS);

  /**
   * Why an s body is not one of the writes the extractor makes, or null. A call is one of three: label changes only
   * (detail[6]: labels from WRITE_LABEL, messages Gmail has, nothing else in it; at most 100), one draft's first save
   * (detail[1] a reply's, detail[2] a new thread's), or one send (detail[13], with the sent labels, in a call whose
   * head says it sends). The parts around the changes as write.ts lays them out.
   */
  function writeRefusal(body) {
    if (!Array.isArray(body) || body.length !== 5 || body[4] !== 2) return 'not a write';
    const sending = Array.isArray(body[0]) && body[0].length === 3 && body[0][0] === null && body[0][1] === null && body[0][2] === 2;
    if (body[0] !== null && !sending) return 'a head not known';
    const c = body[2];
    if (sending ? c !== null : !(Array.isArray(c) && c.length === 7 && c[0] === 1 && (c[1] === null || Number.isInteger(c[1])) && c[2] === null && c[3] === null && Array.isArray(c[4]) && c[4][0] === null && c[4][1] === 0 && c[5] === null && c[6] === 1)) return 'a client part not known';
    const t = body[3];
    if (!Array.isArray(t) || t.length !== 5 || !Number.isInteger(t[0]) || !Number.isInteger(t[1]) || !Number.isInteger(t[2]) || t[3] !== (sending ? 1 : 0) || t[4] !== 49) return 'a time part not known';
    if (!Array.isArray(body[1]) || body[1].length !== 1 || !Array.isArray(body[1][0]) || !body[1][0].length || body[1][0].length > 100) return 'no changes, or too many';
    const kinds = body[1][0].map((ch) => (Array.isArray(ch) && Array.isArray(ch[1]) && Array.isArray(ch[1][1]) ? ch[1][1].findIndex((x) => x !== null) : -1));
    if (sending ? kinds.length !== 1 || kinds[0] !== 13 : kinds.some((k) => k !== 6) && (kinds.length !== 1 || (kinds[0] !== 1 && kinds[0] !== 2))) return 'changes of kinds not made together';
    if (t[1] !== kinds.length) return 'a count that is not the changes';
    for (const ch of body[1][0]) {
      if (!Array.isArray(ch) || ch.length !== 2 || !Number.isInteger(ch[0]) || !Array.isArray(ch[1]) || typeof ch[1][0] !== 'string' || !W_THREAD.test(ch[1][0]) || !Array.isArray(ch[1][1])) return 'a change not laid out as known';
      const d = ch[1][1];
      const parts = [];
      d.forEach((x, i) => x !== null && parts.push(i));
      if (parts.length !== 1) return 'a change of more than one part';
      const v = d[parts[0]];
      if (parts[0] === 6) {
        if (!ch[1][0].startsWith('thread-f:') || d.length !== 7 || !Array.isArray(v) || v.length !== 12 || !v.slice(3).every((x) => x === null) || !labelsOk(v[0], true) || !labelsOk(v[1], false) || (v[0] === null && v[1] === null)) return 'a label change not made here';
        if (!Array.isArray(v[2]) || !v[2].length || v[2].length > 1000 || !v[2].every((m) => typeof m === 'string' && W_MSG_F.test(m))) return 'a label change on messages Gmail has not got';
      } else if (parts[0] === 1) {
        if (sending || !ch[1][0].startsWith('thread-f:') || !Array.isArray(v) || !recordOk(v[0], false) || !W_MSG_F.test(String(v[1]))) return 'a reply draft not laid out as known';
      } else if (parts[0] === 2) {
        if (sending || !Array.isArray(v) || v.length !== 1 || !Array.isArray(v[0]) || v[0][3] !== ch[1][0] || !Array.isArray(v[0][4]) || v[0][4].length !== 1 || !recordOk(v[0][4][0], false)) return 'a draft not laid out as known';
      } else if (parts[0] === 13) {
        if (!sending || !Array.isArray(v) || !recordOk(v[0], true) || (v[1] !== null && !W_MSG_F.test(String(v[1])))) return 'a send not laid out as known';
      } else return 'a change of a kind not made here';
    }
    return null;
  }

  /** gmail.write: one of the writes writeRefusal knows, POSTed to the page's own s as the page posts its writes. */
  async function writeCall(body) {
    const no = writeRefusal(body);
    if (no) throw new Error('gmail.write: refused, ' + no);
    if (!sync.seen || !sync.base) return { status: 0, error: 'no-sync-yet' };
    const q = new URLSearchParams();
    if (sync.query.hl !== undefined) q.set('hl', sync.query.hl);
    q.set('c', String(++sync.c));
    if (sync.query.rt !== undefined) q.set('rt', sync.query.rt);
    if (sync.query.pt !== undefined) q.set('pt', sync.query.pt);
    const headers = {};
    for (const [n, v] of sync.headers || []) headers[n] = v;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    const res = await cloak.apply(nativeFetch, window, [location.origin + sync.base + 's?' + q.toString(), { method: 'POST', headers, body: jsonStringify(body), credentials: 'include', cache: 'no-store' }]);
    const text = await res.text();
    let json;
    try {
      json = jsonParse(text.replace(/^\s*\)\]\}'[^\n]*(?:\n|$)/, ''));
    } catch (e) {}
    if (json === undefined) return { status: res.status, error: 'not-json', page: learn.pageKind(res.status, res.headers.get('content-type'), text, res.url) };
    return { status: res.status, json };
  }

  // gmail.upload: an attachment, handed over in pieces (gmail.uploadChunk), then uploaded as the page uploads one: a
  // resumable start to /_/upload with its metadata, then the bytes; Gmail's answer is the token a draft names it by.
  const UPLOAD_MAX = 26 * 1024 * 1024;
  const uploads = new Map();
  let uploadSeq = 0;
  function uploadChunk(c) {
    for (const [k, v] of uploads) if (Date.now() - v.at > 120000) uploads.delete(k);
    // A piece of an upload this page does not hold (it reloaded since the first piece) starts nothing: the file would go short.
    if (c.token !== undefined && c.token !== null && !uploads.has(c.token)) throw new Error('gmail.uploadChunk: no such upload (the page was reloaded?)');
    let u = c.token ? uploads.get(c.token) : null;
    if (!u) {
      if (uploads.size >= 4) throw new Error('gmail.uploadChunk: too many uploads at once');
      u = { token: 'u' + ++uploadSeq + '.' + Date.now(), parts: [], size: 0, at: Date.now() };
      uploads.set(u.token, u);
    }
    const bin = atob(String(c.base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u.parts.push(bytes);
    u.size += bytes.length;
    if (u.size > UPLOAD_MAX) {
      uploads.delete(u.token);
      throw new Error('gmail.uploadChunk: over the size an attachment may have');
    }
    return { token: u.token, size: u.size };
  }
  async function uploadSend(c) {
    const u = uploads.get(c.token);
    uploads.delete(c.token);
    if (!u) throw new Error('gmail.upload: no such upload');
    if (u.size !== c.size) throw new Error('gmail.upload: the file came over short');
    const name = String(c.name || '');
    const mime = String(c.mime || '');
    if (!name || name.length > 255 || /[\r\n]/.test(name) || !/^[\w.+-]+\/[\w.+-]+$/.test(mime) || !/^[A-Za-z0-9_-]{8,8000}$/.test(String(c.meta || ''))) throw new Error('gmail.upload: not an attachment');
    // Header values are bytes: a name outside ASCII goes percent-encoded.
    const fileName = /^[\x20-\x7e]*$/.test(name) ? name : encodeURIComponent(name);
    const base = location.origin + '/_/upload?authuser=' + encodeURIComponent(String(settings.authuser)) + '&dcp=asu-n';
    const start = await cloak.apply(nativeFetch, window, [base, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'X-Goog-Upload-File-Name': fileName, 'X-Goog-Metadata-Proto-Format': 'b', 'X-Goog-Upload-Header-Content-Length': String(u.size), 'X-Goog-Upload-Header-Content-Type': mime, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: c.meta,
    }]);
    const startType = learn.mediaType(start.headers.get('content-type'));
    if (start.status !== 200) return { status: start.status, page: learn.pageKind(start.status, startType, await textUpTo(start, 512 * 1024), start.url) };
    quiet(start.text());
    const next = start.headers.get('x-goog-upload-url');
    let to = null;
    try {
      to = next ? new URL(next, location.href) : null;
    } catch (e) {}
    if (!to || to.origin !== location.origin) return { status: 0, error: 'no-upload-url' };
    const fin = await cloak.apply(nativeFetch, window, [to.href, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': mime, 'X-Goog-Upload-File-Name': fileName, 'X-Goog-Metadata-Proto-Format': 'b', 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
      body: new Blob(u.parts, { type: mime }),
    }]);
    const text = await textUpTo(fin, 64 * 1024);
    if (fin.status !== 200 || fin.headers.get('x-goog-upload-status') !== 'final') return { status: fin.status || 0, error: 'not-final', page: learn.pageKind(fin.status, learn.mediaType(fin.headers.get('content-type')), text, fin.url) };
    return { status: 200, token: text.trim() };
  }

  /** A response's text, up to max characters (the rest is not read). */
  async function textUpTo(res, max) {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) return text + dec.decode();
      text += dec.decode(r.value, { stream: true });
      if (text.length > max) {
        quiet(reader.cancel());
        return text.slice(0, max);
      }
    }
  }

  // gmail.raw: one message's original, kept here (a few at most, two minutes) and handed over in pieces.
  const raws = new Map();
  let rawSeq = 0;
  async function rawFetch(hex, max) {
    if (typeof hex !== 'string' || !/^[0-9a-f]{1,16}$/.test(hex)) throw new Error('gmail.raw: not a message id');
    if (!sync.ik) return { status: 0, error: 'no-ik' };
    const cap = Number.isInteger(max) && max > 0 ? max : 50 * 1024 * 1024;
    const base = sync.mailBase || '/mail/u/' + encodeURIComponent(String(settings.authuser)) + '/';
    const url = location.origin + base + '?ik=' + encodeURIComponent(sync.ik) + '&view=att&th=' + hex + '&attid=0&disp=comp&safe=1&zw';
    const res = await cloak.apply(nativeFetch, window, [url, { credentials: 'include', cache: 'no-store' }]);
    const type = learn.mediaType(res.headers.get('content-type'));
    // An HTML page (or a 429) is not a message: only what it reads as goes up, never its text or bytes.
    if (type === 'text/html' || res.status === 429) return { status: res.status, type, page: learn.pageKind(res.status, type, await textUpTo(res, 512 * 1024), res.url) };
    if (res.status !== 200 || !res.body) {
      if (res.body) quiet(res.body.cancel());
      return { status: res.status, type };
    }
    if (Number(res.headers.get('content-length')) > cap) {
      quiet(res.body.cancel());
      return { status: 200, tooBig: Number(res.headers.get('content-length')), type };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      n += r.value.byteLength;
      if (n > cap) {
        quiet(reader.cancel());
        return { status: 200, tooBig: n, type };
      }
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    for (const [k, v] of raws) if (Date.now() - v.at > 120000) raws.delete(k);
    while (raws.size >= 3) raws.delete(raws.keys().next().value);
    const token = 'r' + ++rawSeq;
    raws.set(token, { bytes, at: Date.now() });
    return { status: 200, token, size: n, type };
  }
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += cloak.apply(fromCharCode, String, bytes.subarray(i, i + 0x8000));
    return cloak.apply(btoaNative, window, [bin]);
  }
  function rawChunk(token, offset, length) {
    const r = raws.get(token);
    if (!r) throw new Error('gmail.rawChunk: no such download');
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const end = Math.min(r.bytes.length, start + Math.min(Math.max(1, Math.floor(Number(length) || 0)), 4 * 1024 * 1024));
    return { base64: toBase64(r.bytes.subarray(start, end)) };
  }

  // The wrappers are methods (no prototype) and cloak.replace makes each read like the native it stands in for.
  const fetchWrapper = {
    fetch(input, init) {
      let ctx = null;
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
        const auth = headerOf(init && init.headers, 'authorization') || (input instanceof Request ? input.headers.get('authorization') : null);
        note(url, auth);
        syncNote(url, (init && init.headers) || (input instanceof Request ? input.headers : null), init && typeof init.body === 'string' ? init.body : null);
        ctx = learnFetchStart(input, init, url);
      } catch (e) {}
      const p = cloak.apply(nativeFetch, this, arguments);
      if (!ctx) return p;
      // The page gets a promise of its own that settles as the native's does: the native's is ours to watch, so a
      // rejection the page leaves unhandled still reaches its unhandledrejection.
      return new PromiseC((resolve, reject) => {
        cloak.apply(promiseThen, p, [
          (res) => {
            resolve(res);
            learnFetchEnd(ctx, res);
          },
          reject,
        ]);
      });
    },
  }.fetch;
  cloak.replace(window, 'fetch', () => fetchWrapper);

  const xhr = XMLHttpRequest.prototype;
  const xhrs = new WeakMap();
  cloak.replace(xhr, 'open', (xOpen) => {
    const open = {
      open(method, url) {
        try {
          xhrs.set(this, { url: String(url), method: typeof method === 'string' ? method : null, auth: null, type: null, headers: [] });
        } catch (e) {}
        return cloak.call(xOpen, this, arguments, open);
      },
    }.open;
    return open;
  });
  cloak.replace(xhr, 'setRequestHeader', (xHeader) => {
    const setRequestHeader = {
      setRequestHeader(name, value) {
        try {
          const x = xhrs.get(this);
          const n = x ? String(name).toLowerCase() : '';
          if (n === 'authorization') x.auth = String(value);
          else if (n === 'content-type' && typeof value === 'string') x.type = value;
          if (x && x.headers.length < 40) x.headers.push([n, String(value)]);
        } catch (e) {}
        return cloak.call(xHeader, this, arguments, setRequestHeader);
      },
    }.setRequestHeader;
    return setRequestHeader;
  });
  cloak.replace(xhr, 'send', (xSend) => {
    const send = {
      send(body) {
        try {
          const x = xhrs.get(this);
          if (x) {
            note(x.url, x.auth);
            syncNote(x.url, x.headers, typeof body === 'string' ? body : null);
            const ctx = recording() ? learnNote(x.method, x.url, x.type, body === undefined ? null : body) : null;
            if (ctx) cloak.apply(addListener, this, ['loadend', () => learnXhrEnd(ctx, this)]);
          }
        } catch (e) {}
        return cloak.call(xSend, this, arguments, send);
      },
    }.send;
    return send;
  });

  // ------------------------------------------------------------ steering the Gmail page (a learn run's commands)
  const sleep = (ms) => new PromiseC((r) => cloak.apply(later, window, [r, ms]));
  const bold = (el) => {
    const w = cloak.apply(computed, window, [el]).fontWeight;
    return w === 'bold' || w === 'bolder' || Number(w) >= 600;
  };

  /**
   * A thread-list row by its own markers. 'read' only when every one of them says so: tr.zA with yO and without zE,
   * no unread sender (zF), bold subject (bqe) or unread row (zE) inside it, and neither the row nor its sender or
   * subject drawn bold. 'unread' with zE. Anything else is 'uncertain', which counts as unread.
   */
  function rowState(tr) {
    try {
      const c = tr.classList;
      if (c.contains('zE')) return 'unread';
      if (!c.contains('zA') || !c.contains('yO')) return 'uncertain';
      if (tr.querySelector('.zE, .zF, .bqe')) return 'uncertain';
      if (bold(tr)) return 'uncertain';
      const parts = tr.querySelectorAll('.yW, .yW > span, .yW > span > span, .y6, .y6 > span, .bog, .bog > span');
      for (let i = 0; i < parts.length && i < 40; i++) if (bold(parts[i])) return 'uncertain';
      return 'read';
    } catch (e) {
      return 'uncertain';
    }
  }

  /** The thread list's rows that are on screen (Gmail keeps other views' lists in the page, hidden). */
  function shownRows() {
    const scope = document.querySelector('[role="main"]') || document;
    const out = [];
    for (const tr of scope.querySelectorAll('tr.zA')) {
      try {
        if (tr.getClientRects().length && cloak.apply(computed, window, [tr]).visibility === 'visible') out.push(tr);
      } catch (e) {}
    }
    return out;
  }

  /** A person's click on el, in its middle: pointer and mouse, down, up, click. */
  function click(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0), button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const steps = [
      [PointerEv, 'pointerover', 0, 0],
      [MouseEv, 'mouseover', 0, 0],
      [PointerEv, 'pointerdown', 1, 0],
      [MouseEv, 'mousedown', 1, 1],
      [PointerEv, 'pointerup', 0, 0],
      [MouseEv, 'mouseup', 0, 1],
      [MouseEv, 'click', 0, 1],
    ];
    for (const [C, type, buttons, detail] of steps) cloak.apply(dispatchNative, el, [new C(type, { ...at, buttons, detail })]);
  }

  /** gmail.openRead: open the index-th row of the list shown that is certainly read (0: the first), as a person would. */
  async function openRead(index) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 49) throw new Error('openRead: the index is a whole number, 0 to 49');
    const rows = shownRows();
    if (!rows.length) return { opened: false, reason: 'no thread list is shown' };
    const read = rows.filter((tr) => rowState(tr) === 'read');
    const tr = read[index];
    if (!tr) return { opened: false, reason: `the list shows ${read.length} read and ${rows.length - read.length} unread or uncertain rows; there is no read row ${index}` };
    const target = tr.querySelector('.y6') || tr.querySelector('.xT') || tr.querySelector('td.xY') || tr;
    try {
      target.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
    // Once more, as the row is now, just before the click.
    if (!tr.isConnected || rowState(tr) !== 'read') return { opened: false, reason: 'the row was no longer certainly read' };
    const before = location.href;
    click(target);
    for (let i = 0; i < 20 && location.href === before; i++) await sleep(100);
    return location.href !== before ? { opened: true } : { opened: false, reason: 'the row was clicked, but the page did not open it' };
  }

  /** gmail.nav, gmail.openRead, gmail.back, gmail.shapes, and the mail calls (gmail.sync, gmail.raw, …): in the Gmail page only. */
  async function gmailCommand(c) {
    if (role() !== 'gmail') throw new Error(`${c.kind}: only in the Gmail page`);
    switch (c.kind) {
      case 'gmail.nav': {
        const hash = learn.navHash(c.hash); // checked here again, whatever the extractor checked
        const before = location.href;
        location.hash = hash;
        return { changed: location.href !== before };
      }
      case 'gmail.openRead':
        return openRead(c.index);
      case 'gmail.back':
        cloak.apply(histBack, history, []);
        return {};
      case 'gmail.shapes':
        return shapes();
      case 'gmail.syncInfo':
        return { sync: sync.seen, headers: sync.headers ? sync.headers.length : 0, ik: !!sync.ik, history: sync.history };
      case 'gmail.sync':
        return syncCall(c.endpoint, c.body);
      case 'gmail.raw':
        return rawFetch(c.hex, c.max);
      case 'gmail.rawChunk':
        return rawChunk(c.token, c.offset, c.length);
      case 'gmail.rawDrop':
        raws.delete(c.token);
        return {};
      case 'gmail.write':
        return writeCall(c.body);
      case 'gmail.uploadChunk':
        return uploadChunk(c);
      case 'gmail.upload':
        return uploadSend(c);
    }
    throw new Error(`no command ${c.kind}`);
  }

  /** API keys in the page as served, once. */
  function scanHtml() {
    try {
      for (const k of new Set(document.documentElement.innerHTML.match(KEY) || [])) if (!keys.has(k)) keys.set(k, 'page-html');
      report();
    } catch (e) {}
  }

  // ------------------------------------------------------------ signed in, and as whom
  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-.]/g, '\\$&') + '=([^;]*)'));
    return m ? m[1] : null;
  }
  /** The account button's label reads "Google Account: Name (email)". Nulls until the page has drawn it. */
  function account() {
    try {
      for (const el of document.querySelectorAll('[aria-label*="Google Account:"]')) {
        const label = el.getAttribute('aria-label') || '';
        const m = label.match(/\(([^()\s]+@[^()\s]+)\)/);
        if (!m) continue;
        const n = label.match(/Google Account:\s*([^()]*?)\s*\(/);
        return { email: m[1], name: n && n[1] ? n[1].replace(/\s+/g, ' ').slice(0, 200) : null };
      }
    } catch (e) {}
    return { email: null, name: null };
  }
  let lastSession = '';
  function session(force) {
    const a = account();
    const s = { t: 'session', signedIn: !!cookie('SAPISID'), email: a.email, name: a.name };
    const k = JSON.stringify(s);
    if (k === lastSession && !force) return;
    lastSession = k;
    post(s);
  }

  // ------------------------------------------------------------ gfetch
  async function sha1(s) {
    const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  /** SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>, and the 1P/3P parts for the cookies that exist. */
  async function authorization(withU) {
    const ts = Math.floor(Date.now() / 1000);
    const out = [];
    for (const [scheme, name] of [
      ['SAPISIDHASH', 'SAPISID'],
      ['SAPISID1PHASH', '__Secure-1PAPISID'],
      ['SAPISID3PHASH', '__Secure-3PAPISID'],
    ]) {
      const v = cookie(name);
      if (v) out.push(`${scheme} ${ts}_${await sha1(`${ts} ${v} ${location.origin}`)}${withU ? '_u' : ''}`);
    }
    return out.join(' ');
  }

  async function gfetch(c) {
    const u = new URL(c.url);
    if (!((u.protocol === 'https:' && googleHost(u.hostname)) || testOrigin(u.origin))) throw new Error('gfetch: only Google APIs');
    for (const [k, v] of Object.entries(c.query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    // No X-Origin: it says the call came through Google's cross-domain proxy iframe (XD3), and Google then wants the
    // request's Origin to be the API's own host ("Origin doesn't match Host for XD3", a 400). A direct call's Origin
    // is the page's, which is what the hash is made with.
    const headers = { accept: 'application/json', 'X-Goog-AuthUser': String(settings.authuser) };
    const auth = await authorization(c.auth === 'u');
    if (auth) headers.Authorization = auth;
    if (c.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await cloak.apply(nativeFetch, window, [
      u.href,
      {
        method: c.method || 'GET',
        headers,
        body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
        credentials: 'include',
        cache: 'no-store',
      },
    ]);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch (e) {}
    return { status: res.status, retryAfter: res.headers.get('retry-after'), ...(json !== undefined ? { json } : { text: text.slice(0, 2000) }) };
  }

  // ------------------------------------------------------------ the pipe
  cloak.onDown(async (p) => {
    if (p.t === 'settings') {
      settings = { ...settings, ...p.settings };
      // What was recorded before the page knew its role is only kept if it is the Gmail page.
      if (role() !== 'gmail') {
        learned.clear();
        learnDropped = 0;
        sync.seen = false;
        sync.base = sync.headers = sync.history = sync.ik = sync.mailBase = null;
      }
      // The pipe is up (again): say everything once more, in case the first words were lost.
      announce();
      session(true);
      sendSeen();
      return;
    }
    if (p.t !== 'cmd' || !p.cmd) return;
    try {
      const kind = String(p.cmd.kind);
      let result;
      if (kind === 'gfetch') result = await gfetch(p.cmd);
      else if (kind.startsWith('gmail.')) result = await gmailCommand(p.cmd);
      else throw new Error(`no command ${kind}`);
      post({ t: 'reply', id: p.id, ok: true, result });
    } catch (err) {
      post({ t: 'reply', id: p.id, ok: false, error: String((err && err.message) || err) });
    }
  });

  announce();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanHtml, { once: true });
  else scanHtml();
  session(false);
  setInterval(() => session(false), 2000);
  log('debug', 'hook loaded');
})();
