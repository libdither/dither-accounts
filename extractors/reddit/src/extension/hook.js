/*
 * MAIN-world content script on old.reddit.com and www.reddit.com, at document_start (docs/reddit.md).
 *
 * It (a) says which page the browser is on: Reddit's sign-in pages, a check, the signed-in old.reddit.com (its
 * `r.config`: `logged` is the username, `modhash` the page's token for writes; the modhash itself never leaves the
 * page), or another page; and (b) runs the extractor's reads and writes as old.reddit.com's own code makes them, from
 * this page, with its cookies: GETs of the `.json` listings, the pages a person opens when Reddit refuses those (read
 * from the page's own markup; "pages, read as a person sees them" below), and POSTs to /api/vote, /api/comment, /api/del, /api/submit and /api/morechildren with the page's modhash as `uh`, the way old reddit's `$.request` adds it. Only
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
  const watch = commandWatch({ post, log, name: (c) => (c.kind === 'get' || c.kind === 'post' || c.kind === 'page' ? `${c.kind} ${watchPath(String(c.path || '').split('?')[0])}` : String(c.kind)) });

  let testOrigin = null;
  const OLD = 'https://old.reddit.com';
  const isOld = () => location.origin === OLD || (testOrigin && location.origin === testOrigin);

  // ------------------------------------------------------------ what may be asked
  const GETS = [
    /^\/(new|best)\.json\?/,
    /^\/message\/inbox\.json\?(.*&)?mark=false(&|$)/,
    /^\/comments\/[a-z0-9]{1,13}(\/_\/[a-z0-9]{1,13})?\.json\?/,
    /^\/api\/info\.json\?id=t[134]_[a-z0-9]{1,13}(&|$)/,
    /^\/user\/[A-Za-z0-9_-]{1,32}\/(about|overview)\.json(\?|$)/,
  ];
  const POSTS = /^\/api\/(vote|comment|del|submit|morechildren)$/;
  // Pages a person opens, read when Reddit refuses their `.json`: the front page sorted New or Best (and the pages after
  // it, by the page's own "next" link), and a post's or a comment's comments page.
  const PAGES = [/^\/(new|best)\/(\?|$)/, /^\/comments\/[a-z0-9]{1,13}\/(_\/[a-z0-9]{1,13}\/)?(\?|$)/];

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

  // ------------------------------------------------------------ pages, read as a person sees them
  // When Reddit's network security refuses a `.json` read (as it does for the front page's New since autumn 2026), the
  // same thing is read from the page a person opens: old reddit draws every post and comment with its facts in data-
  // attributes (`data-fullname`, `data-author`, `data-timestamp`, ...). What comes back has the shape of the `.json`
  // (a Listing of t3, or a post's [Listing, Listing of t1]), so the extractor parses it as it parses those. Only what
  // the page itself shows is read: the next page is the page's own "next" link, never an address made up here.

  const attr = (el, name) => {
    const v = el && el.getAttribute(name);
    return v == null ? null : v;
  };
  const num = (v) => (v != null && /^-?\d+$/.test(String(v).trim()) ? Number(v) : null);
  const secs = (el) => {
    const t = el && el.getAttribute('datetime');
    const ms = t ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms / 1000 : null;
  };
  /** The entry's own parts, not a nested comment's: the first match that has no other thing between it and `thing`. */
  const own = (thing, sel) => {
    for (const el of thing.querySelectorAll(sel)) if (el.closest('.thing') === thing) return el;
    return null;
  };
  /** Up, down or neither, from the arrows' column (`likes`, `dislikes`, `unvoted`). */
  const voteOf = (thing) => {
    const col = own(thing, '.midcol') || own(thing, '.entry');
    if (!col) return undefined;
    if (col.classList.contains('likes')) return true;
    if (col.classList.contains('dislikes')) return false;
    return null;
  };
  /** A post's or comment's rendered text, back as plain Markdown: paragraphs, quotes, lists, code, links. */
  function mdText(root) {
    if (!root) return '';
    const inline = (n) => {
      let out = '';
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType !== 1) continue;
        else if (c.tagName === 'A') {
          const t = inline(c);
          const href = c.getAttribute('href') || '';
          out += href && href !== t && !href.startsWith('javascript:') ? `[${t}](${href})` : t;
        } else if (c.tagName === 'BR') out += '\n';
        else if (c.tagName === 'CODE') out += '`' + c.textContent + '`';
        else out += inline(c);
      }
      return out;
    };
    const blocks = [];
    const walk = (n, prefix) => {
      for (const c of n.children) {
        const tag = c.tagName;
        if (tag === 'P' || /^H[1-6]$/.test(tag)) blocks.push(prefix + inline(c).trim());
        else if (tag === 'BLOCKQUOTE') walk(c, prefix + '> ');
        else if (tag === 'PRE') blocks.push(prefix + '```\n' + c.textContent.replace(/\n$/, '') + '\n```');
        else if (tag === 'UL' || tag === 'OL') {
          let i = 0;
          const items = [];
          for (const li of c.children) if (li.tagName === 'LI') items.push(prefix + (tag === 'OL' ? `${++i}. ` : '- ') + inline(li).trim());
          blocks.push(items.join('\n'));
        } else if (tag === 'HR') blocks.push(prefix + '---');
        else if (tag === 'TABLE') blocks.push(prefix + c.textContent.replace(/\s+/g, ' ').trim());
        else if (tag === 'DIV') walk(c, prefix);
        else blocks.push(prefix + inline(c).trim());
      }
    };
    walk(root, '');
    return blocks.filter((b) => b.replace(/[>\s]/g, '')).join('\n\n');
  }
  const PIC = /^https:\/\/(i|preview)\.redd\.it\/|^https:\/\/([a-z]\.)?thumbs\.redditmedia\.com\//;
  /** A post row (`.thing.link`), as the `.json`'s t3 data. */
  function linkData(thing, page) {
    const name = attr(thing, 'data-fullname');
    if (!name || !/^t3_[a-z0-9]{1,13}$/.test(name)) return null;
    const title = own(thing, 'a.title') || own(thing, 'p.title a');
    const url = attr(thing, 'data-url');
    const self = thing.classList.contains('self') || /^self\./.test(attr(thing, 'data-domain') || '');
    const d = {
      name,
      id: name.slice(3),
      title: title ? title.textContent.trim() : null,
      author: attr(thing, 'data-author'),
      subreddit: attr(thing, 'data-subreddit'),
      subreddit_id: attr(thing, 'data-subreddit-fullname'),
      created_utc: num(attr(thing, 'data-timestamp')) != null ? num(attr(thing, 'data-timestamp')) / 1000 : secs(own(thing, 'time')),
      permalink: attr(thing, 'data-permalink'),
      url: url,
      is_self: self,
      score: num(attr(thing, 'data-score')),
      num_comments: num(attr(thing, 'data-comments-count')),
      over_18: attr(thing, 'data-nsfw') === 'true' || thing.classList.contains('over18'),
      spoiler: attr(thing, 'data-spoiler') === 'true' || thing.classList.contains('spoiler'),
      promoted: attr(thing, 'data-promoted') === 'true' || thing.classList.contains('promoted') || thing.classList.contains('promotedlink'),
      pinned: thing.classList.contains('stickied'),
      likes: voteOf(thing),
    };
    // Its picture: the link itself when it is one on Reddit's picture host, else the row's thumbnail.
    const abs = url && url.startsWith('//') ? 'https:' + url : url;
    const thumb = own(thing, 'a.thumbnail img');
    const tsrc = thumb && (thumb.getAttribute('src') || '');
    const t = tsrc && tsrc.startsWith('//') ? 'https:' + tsrc : tsrc;
    const okPic = (u) => !!u && (PIC.test(u) || (!!testOrigin && u.startsWith(testOrigin + '/')));
    const pic = abs && /^https:\/\/i\.redd\.it\//.test(abs) ? abs : okPic(t) ? t : null;
    if (pic) d.preview = { images: [{ source: { url: pic } }] };
    if (thing.classList.contains('video') || attr(thing, 'data-kind') === 'video') d.is_video = true;
    if (page && self) d.selftext = mdText(own(thing, '.expando .md') || own(thing, '.usertext-body .md'));
    return d;
  }
  /** A comment (`.thing.comment`), with its answers nested as the `.json` has them; or a "more" (load more, continue). */
  function commentThing(thing, link, parent) {
    const cls = thing.classList;
    if (cls.contains('morechildren')) {
      const a = own(thing, 'a[onclick*="morechildren"]') || own(thing, '.morecomments a');
      const m = /morechildren\([^,]*,\s*'[^']*',\s*'[^']*',\s*'([a-z0-9,]+)'/.exec((a && a.getAttribute('onclick')) || '');
      const children = m ? m[1].split(',').filter(Boolean) : [];
      const gray = own(thing, '.gray');
      const count = num(((gray && gray.textContent) || '').replace(/\D+/g, ' ').trim().split(' ')[0]) || children.length;
      return children.length ? { kind: 'more', data: { id: children[0], parent_id: parent, children, count } } : null;
    }
    if (cls.contains('morerecursion')) return { kind: 'more', data: { id: '_', parent_id: parent, children: [], count: 0 } };
    if (!cls.contains('comment')) return null;
    const name = attr(thing, 'data-fullname');
    if (!name || !/^t1_[a-z0-9]{1,13}$/.test(name)) return null;
    const vote = voteOf(thing);
    const scoreEl = own(thing, `.tagline .score.${vote === true ? 'likes' : vote === false ? 'dislikes' : 'unvoted'}`) || own(thing, '.tagline .score');
    const time = (() => {
      for (const el of thing.querySelectorAll('.tagline time')) if (el.closest('.thing') === thing && !el.classList.contains('edited-timestamp')) return el;
      return null;
    })();
    const author = attr(thing, 'data-author') || (own(thing, '.tagline .author') ? own(thing, '.tagline .author').textContent.trim() : '[deleted]');
    const kidsBox = own(thing, '.child > .sitetable') || own(thing, '.child .sitetable');
    return {
      kind: 't1',
      data: {
        name,
        id: name.slice(3),
        author,
        body: mdText(own(thing, '.usertext-body .md')),
        created_utc: secs(time),
        permalink: attr(thing, 'data-permalink'),
        subreddit: attr(thing, 'data-subreddit'),
        subreddit_id: attr(thing, 'data-subreddit-fullname'),
        link_id: link,
        parent_id: parent,
        score: num(scoreEl && (scoreEl.getAttribute('title') || '').trim()),
        score_hidden: !!own(thing, '.score-hidden'),
        likes: vote,
        stickied: cls.contains('stickied'),
        replies: kidsBox ? commentListing(kidsBox, link, name) : '',
      },
    };
  }
  function commentListing(box, link, parent) {
    const children = [];
    for (const el of box.children) {
      if (!el.classList.contains('thing')) continue;
      const c = commentThing(el, link, parent);
      if (c) children.push(c);
    }
    return { kind: 'Listing', data: { children, after: null } };
  }
  const listing = (children, after) => ({ kind: 'Listing', data: { children, after } });

  /** A listing page's posts and its "next" link; a comments page's post and comments. */
  function scrape(doc, path) {
    const out = { rows: 0 };
    if (/^\/comments\//.test(path)) {
      const linkEl = doc.querySelector('#siteTable .thing.link, .sitetable.linklisting .thing.link, .thing.link[data-fullname^="t3_"]');
      const d = linkEl && linkData(linkEl, true);
      if (!d) return { data: null, shape: 'no post on the comments page' };
      const box = doc.querySelector('.commentarea .sitetable.nestedlisting') || doc.querySelector('.commentarea > .sitetable') || doc.querySelector('.commentarea .sitetable');
      const comments = box ? commentListing(box, d.name, d.name) : listing([], null);
      return { data: [listing([{ kind: 't3', data: d }], null), comments], shape: null };
    }
    const table = doc.querySelector('#siteTable') || doc.querySelector('.sitetable.linklisting') || doc.body;
    const children = [];
    for (const el of table.querySelectorAll('.thing[data-fullname^="t3_"]')) {
      if (el.closest('.thing') !== el || el.parentElement.closest('.thing')) continue;
      out.rows++;
      const d = linkData(el, false);
      if (d && !d.promoted) children.push({ kind: 't3', data: d });
    }
    const nextA = doc.querySelector('.nav-buttons .next-button a, a[rel~="next"]');
    let next = null;
    let after = null;
    if (nextA) {
      try {
        const u = new URL(nextA.getAttribute('href'), location.href);
        if (u.origin === location.origin && PAGES.some((re) => re.test(u.pathname + u.search))) {
          next = (u.pathname + u.search).slice(0, 300);
          after = u.searchParams.get('after');
        }
      } catch (e) {}
    }
    if (!out.rows && !doc.querySelector('#siteTable, .sitetable')) return { data: null, shape: 'no list of posts on the page' };
    const l = listing(children, after && /^t3_[a-z0-9]{1,13}$/.test(after) ? after : null);
    if (next) l.data.next = next;
    return { data: l, shape: null };
  }

  async function readPage(cmd) {
    const path = String(cmd.path || '');
    if (!isOld()) throw new Error('not on old.reddit.com');
    if (!PAGES.some((re) => re.test(path))) throw new Error('not a page this hook reads');
    const res = await cloak.apply(nativeFetch, window, [path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/html' } }]);
    const text = await res.text();
    if (!res.ok) return asJson(new Response(text, { status: res.status, headers: res.headers }));
    const doc = new DOMParser().parseFromString(text, 'text/html');
    if (doc.querySelector('form#login_login, form.login-form') && !doc.querySelector('.thing')) throw new Error('Reddit showed its sign-in page, not the page asked for');
    const got = scrape(doc, path.split('?')[0]);
    // The page answered but is not drawn as old reddit draws it: say what was missing, so the status says which read broke.
    if (!got.data) throw new Error(`Reddit's page is not laid out as known: ${got.shape}`);
    return got.data;
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
      else if (k === 'page') result = await readPage(p.cmd);
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
