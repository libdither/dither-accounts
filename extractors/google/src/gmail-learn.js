/*
 * What the Gmail page's traffic recorder keeps, and which searches it may steer the page to: the shapes of the page's
 * own requests and responses (never their values), and the one check every `gmail.nav` passes (operators only). And
 * what an answer that is not mail reads as (pageKind: a sign-in or verification page), which stops the background lane.
 *
 * The block between the learn:begin and learn:end lines is in the Gmail hook too (src/extension/hook.js), word for
 * word: a content script cannot import, and the page must not be able to reach a module of ours. main.ts (navHash)
 * and the tests use this copy; test/gmail-learn.test.ts keeps the two the same. Plain JS, no DOM: it runs in the page,
 * under Bun and in the tests alike. docs/google.md, "Learning Gmail's protocol", has the rules in prose.
 */

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

export const { shape, shapeBody, requestShape, pathTemplate, mediaType, navHash, pageKind, OPS, VIEWS } = learn;
