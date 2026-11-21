/*
 * MAIN-world content script on old.reddit.com and www.reddit.com, at document_start (docs/reddit.md).
 *
 * It (a) says which page the browser is on: Reddit's sign-in pages, a check, the signed-in old.reddit.com (its
 * `r.config`: `logged` is the username, `modhash` the page's token for writes; the modhash itself never leaves the
 * page), or another page; and (b) runs the extractor's reads and writes as old.reddit.com's own code makes them, from
 * this page, with its cookies: GETs of the `.json` listings (your subscriptions and a group of them sorted New among
 * them), and POSTs to /api/vote, /api/comment, /api/del, /api/submit and /api/morechildren with the page's modhash as `uh`, the way old reddit's `$.request` adds it. Only
 * the paths below are let through, and only on old.reddit.com (or the test origin); nothing marks the inbox read
 * (`mark=false` is required).
 *
 * It talks only to content.js, over the channel in main-world.js (put in below when the extension is copied). Plain JS
 * on purpose.
 */
(() => {
  'use strict';
  /*@include main-world@*/
  /*@include command-watch@*/
  if (!cloak.once()) return;
  const nativeFetch = window.fetch;
  const post = (payload) => cloak.send(payload);
  const log = (level, msg) => post({ t: 'log', level, msg });
  const watch = commandWatch({ post, log, name: (c) => (c.kind === 'get' || c.kind === 'post' ? `${c.kind} ${watchPath(String(c.path || '').split('?')[0])}` : String(c.kind)) });

  let testOrigin = null;
  const OLD = 'https://old.reddit.com';
  const isOld = () => location.origin === OLD || (testOrigin && location.origin === testOrigin);

  // ------------------------------------------------------------ what may be asked
  const GETS = [
    /^\/(new|best|hot)\.json\?/,
    // Following from the subscriptions, when /new.json is refused: the names, then a group's New (at most 100 names).
    /^\/subreddits\/mine\/subscriber\.json\?/,
    /^\/r\/[A-Za-z0-9_-]{2,40}(\+[A-Za-z0-9_-]{2,40}){0,99}\/new\.json\?/,
    /^\/message\/inbox\.json\?(.*&)?mark=false(&|$)/,
    /^\/comments\/[a-z0-9]{1,13}(\/_\/[a-z0-9]{1,13})?\.json\?/,
    /^\/api\/info\.json\?id=t[134]_[a-z0-9]{1,13}(&|$)/,
    /^\/user\/[A-Za-z0-9_-]{1,32}\/(about|overview)\.json(\?|$)/,
  ];
  const POSTS = /^\/api\/(vote|comment|del|submit|morechildren)$/;

  // ------------------------------------------------------------ the page
  const config = () => {
    try {
      const r = window.r;
      return r && r.config && typeof r.config === 'object' ? r.config : null;
    } catch (e) {
      return null;
    }
  };
  const LOGIN = /^\/(login|register|account\/(login|register|password|reset)|password|reset)(\/|$)/;
  const CHECK = /^\/(verify|verification|challenge|captcha|2fa|account\/(verify|2fa|challenge))(\/|$)/;

  function pageState() {
    const path = location.pathname;
    const c = config();
    const user = c && typeof c.logged === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(c.logged) ? c.logged : null;
    const modhash = !!(c && typeof c.modhash === 'string' && c.modhash.length > 4);
    let state;
    if (CHECK.test(path)) state = 'verify';
    else if (LOGIN.test(path)) state = 'login';
    else if (isOld() && c) state = user ? 'ready' : 'login';
    else if (isOld() && document.readyState !== 'loading') state = 'other';
    else if (isOld()) state = 'loading';
    else state = 'other';
    return { state, path: path.slice(0, 200), user, modhash, old: !!isOld() };
  }

  let last = '';
  function report(force) {
    const s = pageState();
    if (s.state === 'loading') return;
    const k = JSON.stringify(s);
    if (k === last && !force) return;
    last = k;
    post(Object.assign({ t: 'page' }, s));
  }

  // ------------------------------------------------------------ requests, as the page makes them
  async function asJson(res) {
    const text = await res.text();
    if (!res.ok) {
      let words = '';
      try {
        const j = JSON.parse(text);
        words = (j && (j.message || j.reason || j.error)) || '';
      } catch (e) {}
      // A bare refusal says nothing in its body's JSON: then what kind of answer it was, and from where, to tell a
      // block page from a sign-in redirect (no page text beyond its title).
      if (!words) {
        const type = String(res.headers.get('content-type') || '').split(';')[0];
        const title = /<title[^>]*>([^<]{0,80})/i.exec(text);
        let where = '';
        try {
          const u = new URL(res.url);
          if (res.redirected || u.origin !== location.origin) where = `${u.host}${u.pathname}`.slice(0, 60);
        } catch (e) {}
        // Its first visible words too: a page with no title still says why (an age check, a block, a sign-in).
        const said = text
          .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&[a-z#0-9]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100);
        words = [type && `a ${type} answer`, title && `titled "${title[1].trim()}"`, where && `from ${where}`, !text.length && 'empty', said && `saying "${said}"`, text.length && `${text.length} bytes`]
          .filter(Boolean)
          .join(', ');
      }
      const err = new Error(`Reddit answered ${res.status}${words ? `: ${String(words).slice(0, 240)}` : ''}`);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Reddit answered ${res.status} with a page, not data (signed out, or a check?)`);
    }
  }

  async function get(cmd) {
    const path = String(cmd.path || '');
    if (!isOld()) throw new Error('not on old.reddit.com');
    if (!GETS.some((re) => re.test(path))) throw new Error('not a read this hook makes');
    const res = await cloak.apply(nativeFetch, window, [path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }]);
    return asJson(res);
  }

  async function send(cmd) {
    const path = String(cmd.path || '');
    if (!isOld()) throw new Error('not on old.reddit.com');
    if (!POSTS.test(path)) throw new Error('not a write this hook makes');
    const c = config();
    const uh = c && typeof c.modhash === 'string' ? c.modhash : '';
    if (!uh) throw new Error('the page has no modhash (signed out?)');
    const body = new URLSearchParams();
    const form = cmd.form && typeof cmd.form === 'object' ? cmd.form : {};
    for (const k of Object.keys(form)) if (typeof form[k] === 'string') body.set(k, form[k]);
    body.set('uh', uh);
    const res = await cloak.apply(nativeFetch, window, [
      path,
      { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString() },
    ]);
    return asJson(res);
  }

  // ------------------------------------------------------------ the pipe
  cloak.onDown(async (p) => {
    if (p.t === 'settings') {
      testOrigin = (p.settings && p.settings.testOrigin) || null;
      report(true);
      return;
    }
    if (p.t !== 'cmd' || !p.cmd) return;
    const done = watch.take(p);
    if (!done) return;
    try {
      let result;
      const k = p.cmd.kind;
      if (k === 'get') result = await get(p.cmd);
      else if (k === 'post') result = await send(p.cmd);
      else if (k === 'go') {
        // Back to the signed-in old reddit, as a person types its address: from Reddit's new site after signing in.
        location.assign((testOrigin || OLD) + '/');
        result = { going: true };
      } else throw new Error(`no command ${k}`);
      post({ t: 'reply', id: p.id, ok: true, result });
    } catch (err) {
      post({ t: 'reply', id: p.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    } finally {
      done();
    }
  });

  post({ t: 'hook', page: location.origin + location.pathname });
  document.addEventListener('DOMContentLoaded', () => report(false));
  window.addEventListener('load', () => report(false));
  setInterval(() => report(false), 2000);
})();
