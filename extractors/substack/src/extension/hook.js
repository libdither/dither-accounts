/*
 * MAIN-world content script on substack.com, at document_start. Signed in, substack.com is Substack's reader
 * ("reader2": webpack, React), and everything it shows comes from its own JSON calls under /api/v1 on the same origin,
 * made with its session cookie by its fetch helper: `fetch(url, { cache: 'no-cache', method, body: JSON, headers:
 * { 'Content-Type': 'application/json' } })`, with a query built from an object (undefined values left out, arrays as
 * `key[]`). docs/substack.md lists the calls and where in the reader's bundles each was read.
 *
 * This hook makes only those calls, each as the reader makes it for the same click, from a fixed list (CALLS below):
 * nothing here builds a path from what the extractor sends beyond an id or a cursor, checked first. It never calls
 * what marks something seen (POST /api/v1/inbox/seen, POST /api/v1/activity/unread, /reader/feed/<key>/seen,
 * /posts/<id>/seen), so reading here leaves the inbox, the activity bell and the feed as they were.
 *
 * What it says on its own: who is signed in (the reader's preloads, `window._preloads.user`), and which page it is on.
 * Answers are copies of the reader's JSON without what nothing here reads (a post's HTML, tracking parameters).
 * It talks to content.js over the channel in main-world.js (put in below when the extension is copied). Plain JS on
 * purpose (no build step).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  /*@include command-watch@*/
  if (!cloak.once()) return;
  const HOOK_VERSION = 2;
  const settings = { testOrigin: null };
  // The page's fetch as it was at document_start, before any of its scripts ran.
  const pageFetch = window.fetch;

  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg: String(msg).slice(0, 300) });
  const watch = commandWatch({ post, log });

  // ------------------------------------------------------------------ the page
  let lastPage = '';
  function preloads() {
    try {
      const p = window._preloads;
      return p && typeof p === 'object' ? p : null;
    } catch (e) {
      return null;
    }
  }
  function self() {
    const p = preloads();
    const u = p && p.user;
    if (!u || typeof u !== 'object' || (typeof u.id !== 'number' && typeof u.id !== 'string')) return null;
    return { id: String(u.id), name: typeof u.name === 'string' ? u.name : null, handle: typeof u.handle === 'string' ? u.handle : null, photo_url: typeof u.photo_url === 'string' ? u.photo_url : null };
  }
  /** 'loading' until the preloads are there; 'ready' signed in; 'login' signed out or on a sign-in page. */
  function pageState() {
    if (/^\/(sign-in|sign-up|account\/login)/.test(location.pathname)) return 'login';
    const p = preloads();
    if (!p) return 'loading';
    return self() ? 'ready' : 'login';
  }
  function reportPage() {
    const state = pageState();
    const me = self();
    const s = JSON.stringify([state, location.pathname, me && me.id]);
    if (s === lastPage) return;
    lastPage = s;
    post({ t: 'page', state, path: location.pathname.slice(0, 200), self: me });
  }

  // ------------------------------------------------------------------ calls
  const ID = /^\d{1,15}$/;
  const CURSOR = /^[\w\-.:=+/%]{1,2000}$/;
  const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
  const id = (v, what) => {
    const s = String(v);
    if (!ID.test(s)) throw new Error('not a Substack ' + what + ' id');
    return s;
  };
  const cursor = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !CURSOR.test(v)) throw new Error('not a Substack cursor');
    return v;
  };

  /** The reader's query string: entries in the given order, undefined left out. */
  function withQuery(path, query) {
    const parts = [];
    for (const k of Object.keys(query || {})) {
      const v = query[k];
      if (v === undefined) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? path + (path.indexOf('?') >= 0 ? '&' : '?') + parts.join('&') : path;
  }

  // Keys of the reader's answers that nothing on the other side reads, dropped from the copy. A post's page keeps its
  // body_html: it is the post itself (the Feed shows it whole in the post's thread).
  const DROP = new Set(['body_html', 'trackingParameters', 'tracking_parameters', 'dismissFeedbackOptions', 'publicationSettings', 'publicationUserSettings', 'theme', 'postTags', 'audio_items', 'coverImagePalette', 'userStatus', 'plans', 'podcastFields', 'trailer_body_json', 'stripe_publishable_key']);
  const KEEP_BODY = new Set(['body_html']);
  function trim(v, depth, keep) {
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => trim(x, depth + 1, keep));
    const out = {};
    for (const k of Object.keys(v)) if (!DROP.has(k) || (keep && keep.has(k))) out[k] = trim(v[k], depth + 1, keep);
    return out;
  }

  /** One call as the reader's fetch helper makes it; its JSON, or an Error in Substack's words. */
  async function call(method, path, query, json, keep) {
    const init = { cache: 'no-cache', method };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers = { 'Content-Type': 'application/json' };
    }
    const res = await pageFetch.call(window, withQuery(path, query), init);
    let body = null;
    try {
      body = await res.json();
    } catch (e) {}
    if (!res.ok) {
      const said = body && (typeof body.error === 'string' ? body.error : Array.isArray(body.errors) && body.errors[0] && body.errors[0].msg);
      const e = new Error('Substack answered ' + res.status + (said ? ': ' + String(said).slice(0, 160) : ''));
      e.status = res.status;
      throw e;
    }
    return trim(body, 0, keep);
  }

  /** ProseMirror's document for plain text, as the note composer makes it from typed lines. */
  function bodyJson(text) {
    const lines = String(text).split(/[\n\r]/g).filter(Boolean);
    return { type: 'doc', attrs: { schemaVersion: 'v1', title: null }, content: lines.length ? lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) : [{ type: 'paragraph' }] };
  }

  const MEDIA_HOSTS = /(^|\.)substackcdn\.com$|^substack-post-media\.s3\.amazonaws\.com$/;
  async function media(u) {
    let url;
    try {
      url = new URL(String(u));
    } catch (e) {
      throw new Error('not a picture address');
    }
    const test = settings.testOrigin && String(u).startsWith(settings.testOrigin + '/');
    if (!test && !(url.protocol === 'https:' && MEDIA_HOSTS.test(url.hostname))) throw new Error('refusing a picture from outside Substack');
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

  /**
   * Every call this hook makes. Reads: the Activity page's list, the Inbox, the Notes "For you" tab, a note's page, a
   * post's page, their comments, a profile and its feed. Writes: the heart, Restack and its undo, the note composer
   * (a note, a reply), a post's comment box, a note or comment's Delete.
   */
  const CALLS = {
    // The Activity page (and the bell's list): newest first; `after` (the oldest time shown, less 1 ms) for older.
    activity: (c) => call('GET', '/api/v1/activity-feed-web', { filter: 'all', after: c.after !== undefined ? (ISO.test(String(c.after)) ? String(c.after) : bad('a time')) : undefined }),
    // The Inbox (newest posts from what you subscribe to), as substack.com/inbox pages it.
    inbox: (c) => call('GET', '/api/v1/reader/posts', { inboxType: 'inbox', limit: 20, cursor: cursor(c.cursor) }),
    // Home's Notes, its For you tab.
    notes: (c) => call('GET', '/api/v1/reader/feed', { tab: 'for-you', cursor: cursor(c.cursor) }),
    note: (c) => call('GET', '/api/v1/reader/comment/' + id(c.id, 'note')),
    noteReplies: (c) => call('GET', '/api/v1/reader/comment/' + id(c.id, 'note') + '/replies', { comment_id: id(c.id, 'note'), cursor: cursor(c.cursor) }),
    post: (c) => call('GET', '/api/v1/posts/by-id/' + id(c.id, 'post'), undefined, undefined, KEEP_BODY),
    postReplies: (c) => call('GET', '/api/v1/reader/post/' + id(c.id, 'post') + '/replies', { publication_id: id(c.pub, 'publication'), cursor: cursor(c.cursor) }),
    profile: (c) => {
      const h = String(c.handle || '');
      if (!/^[\w.-]{1,60}$/.test(h)) throw new Error('not a Substack handle');
      return call('GET', '/api/v1/user/' + encodeURIComponent(h) + '/public_profile');
    },
    profileFeed: (c) => call('GET', '/api/v1/reader/feed/profile/' + id(c.id, 'user'), { cursor: cursor(c.cursor) }),
    // The heart: on a post, nothing else; on a note or comment, its publication too (null for a note).
    react: (c) =>
      serial(() => {
        const on = c.on === 'comment' ? 'comment' : c.on === 'post' ? 'post' : bad('a post or a comment');
        const extra = on === 'comment' ? { publication_id: c.pub === null || c.pub === undefined ? null : Number(id(c.pub, 'publication')) } : {};
        const path = '/api/v1/' + on + '/' + id(c.id, on) + '/reaction';
        return c.remove ? call('DELETE', path, undefined, extra) : call('POST', path, undefined, { reaction: '❤', ...extra });
      }),
    // Restack, and its undo, from the For you tab.
    restack: (c) =>
      serial(() => {
        const postId = c.post !== undefined ? Number(id(c.post, 'post')) : null;
        const commentId = c.comment !== undefined ? Number(id(c.comment, 'note')) : null;
        if ((postId === null) === (commentId === null)) throw new Error('restack a post or a note');
        return c.remove
          ? call('DELETE', '/api/v1/restack/feed', undefined, { postId, commentId, tabId: 'for-you' })
          : call('POST', '/api/v1/restack/feed', undefined, { postId, commentId, tabId: 'for-you', surface: 'feed' });
      }),
    // The note composer: a new note, or a reply to a note (parent_id).
    note_publish: (c) =>
      serial(() => {
        if (typeof c.text !== 'string' || !c.text.trim()) throw new Error('nothing to post');
        const parent = c.parent !== undefined ? Number(id(c.parent, 'note')) : undefined;
        return call('POST', '/api/v1/comment/feed', undefined, { bodyJson: bodyJson(c.text), parent_id: parent, tabId: 'for-you', surface: 'feed', replyMinimumRole: parent === undefined ? 'everyone' : undefined });
      }),
    // A comment on a post, or a reply to one of its comments (parent_id), as the composer sends it for a post.
    comment_publish: (c) =>
      serial(() => {
        if (typeof c.text !== 'string' || !c.text.trim()) throw new Error('nothing to post');
        const parent = c.parent !== undefined ? Number(id(c.parent, 'comment')) : undefined;
        return call('POST', '/api/v1/post/' + id(c.post, 'post') + '/comment', undefined, { bodyJson: bodyJson(c.text), parent_id: parent, publication_id: Number(id(c.pub, 'publication')) });
      }),
    // Delete a note or comment of your own.
    remove: (c) => serial(() => call('DELETE', '/api/v1/comment/' + id(c.id, 'note'), undefined, { publication_id: c.pub === null || c.pub === undefined ? undefined : Number(id(c.pub, 'publication')) })),
    media: (c) => media(c.url),
    self: () => ({ state: pageState(), self: self(), path: location.pathname.slice(0, 200), version: HOOK_VERSION }),
  };
  function bad(what) {
    throw new Error('not ' + what);
  }

  async function runCommand(cmd) {
    const f = Object.prototype.hasOwnProperty.call(CALLS, cmd.kind) ? CALLS[cmd.kind] : null;
    if (!f) throw new Error('unknown command ' + cmd.kind);
    if (cmd.kind !== 'self' && cmd.kind !== 'media' && pageState() === 'login') throw new Error('Substack is not signed in (live view)');
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
      .catch((err) => post({ t: 'reply', id: payload.id, ok: false, error: String((err && err.message) || err).slice(0, 300) }))
      .finally(done);
  });

  post({ t: 'hook', version: HOOK_VERSION, path: location.pathname.slice(0, 200) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportPage);
  else reportPage();
  setInterval(reportPage, 3000);
  log('info', 'hook ' + HOOK_VERSION + ' installed');
})();
