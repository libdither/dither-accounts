/*
 * A service worker's side of signing in with another account (packages/browser/src/signin.ts; the repo's
 * docs/signin-relay.md). Not a file of the extension: the copy step (markers.ts) puts it in place of a worker's
 * `include signin-worker` marker, and the sandbox adds the chooser page (signin.html, signin-page.js) beside it. It
 * must hold no placeholder: Chromium keeps the worker it first registered (markers.ts, worker.ts).
 *
 *   signinRelay.start(sendUp, cfg)   once, at the top level, with (a promise of) the config.json's `signIn`:
 *                                    { consume: [{ id, name, origins, paths }] }, the providers it asks through
 *   signinRelay.command(msg)         a `cmd` frame from the extractor: true when it was one of ours (`signin.*`)
 *   signinRelay.owns(tabId)          a tab it holds (a chooser, or a provider's tab it opened): tab reports leave it out
 *
 * Asking (cfg.consume names the providers): a tab that sets off for a provider's authorize page is stopped before
 * its request leaves (a block rule) and goes to the chooser page instead, and the extractor hears `signin` with the
 * link. The chooser asks this worker for what to show; a pick
 * goes up as `signin.pick`. The extractor answers with `signin.show` (the choices, or that it is waiting), then
 * `signin.done` (the provider's answer, which the tab loads: the site finishes its own sign-in) or `signin.failed`.
 * "Sign in here instead" lets the link through in that tab, once.
 *
 * Answering: `signin.authorize` opens the link in a tab of its own, in front, with a session rule that stops that tab
 * from loading the redirect address, and answers with the address it was stopped at (the provider's code). The tab
 * closes after. While it is open, `signin.look` (its `aid`) says which of the provider's screens that tab shows (its
 * account chooser, its Continue, or something else) and where on the screen the one thing to press is: the extractor
 * presses it with real input when you set up the link (signin.ts SignInAnswerer). Nothing here logs or keeps a link or
 * a code.
 *
 * Starting one: `signin.seek` reads the site's tab for its "Continue with Google" (or, failing that, its "Sign in")
 * and says where it is on the screen; the extractor clicks it with real input (signin.ts SignInAsker.start), and the
 * sign-in it sets off comes here as any other.
 */
const signinRelay = (() => {
  let up = null;
  let consume = [];
  const relays = new Map(); // rid -> { tabId, provider, name, state, view }
  const byTab = new Map(); // tabId -> rid
  const through = new Map(); // tabId -> until: the provider's page may load there
  const answering = new Set(); // tabs opened to answer a link
  const answerTabs = new Map(); // aid -> tabId: the tab a signin.authorize opened, for signin.look
  let seq = 0;

  const page = () => chrome.runtime.getURL('signin.html');
  const reply = (id, ok, v) => up && up(ok ? { t: 'reply', id, ok: true, result: v, from: 'worker' } : { t: 'reply', id, ok: false, error: String(v), from: 'worker' });

  function providerOf(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    for (const p of consume) if (p.origins.includes(u.origin) && p.paths.some((x) => u.pathname === x || u.pathname.startsWith(x + '/'))) return p;
    return null;
  }

  // ------------------------------------------------------------ asking
  /**
   * The providers' authorize pages never load in this browser, so not one request of a sign-in reaches the provider
   * from here: a block rule each (session rules, ids below 1000; a block needs no host permission), but in the tabs
   * let through. The navigation it stops is still seen (webNavigation, the tab's update), and goes to the chooser.
   */
  async function blockRules() {
    if (!chrome.declarativeNetRequest) return;
    const now = Date.now();
    const excluded = [...through].filter(([, until]) => until > now).map(([id]) => id);
    const rules = [];
    for (const p of consume)
      for (const o of p.origins)
        for (const path of p.paths) rules.push({ id: rules.length + 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '|' + o + path, resourceTypes: ['main_frame'], ...(excluded.length ? { excludedTabIds: excluded } : {}) } });
    try {
      const old = (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.id < 1000).map((r) => r.id);
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old, addRules: rules });
    } catch (e) {}
  }

  function watch(tabId, url) {
    if (!up || typeof tabId !== 'number' || tabId < 0 || !url || answering.has(tabId)) return;
    const p = providerOf(url);
    if (!p) return;
    if ((through.get(tabId) || 0) > Date.now()) return;
    through.delete(tabId);
    const old = byTab.get(tabId);
    // The same link seen again (its navigation starting, committing, the tab's update): one sign-in.
    if (old && relays.get(old) && relays.get(old).url === url) return;
    if (old) relays.delete(old);
    const rid = 'r' + Date.now().toString(36) + '-' + ++seq;
    relays.set(rid, { tabId, url, provider: p.id, name: p.name, view: { state: 'asking', name: p.name } });
    byTab.set(tabId, rid);
    chrome.tabs.update(tabId, { url: page() + '#' + rid }).catch(() => {});
    up({ t: 'signin', rid, provider: p.id, url });
  }

  function drop(rid) {
    const r = relays.get(rid);
    if (!r) return;
    relays.delete(rid);
    if (byTab.get(r.tabId) === rid) byTab.delete(r.tabId);
  }

  function fromChooser(m, sender, answer) {
    if (!m || typeof m.t !== 'string' || !m.t.startsWith('signin.')) return false;
    // Only our own chooser page, never a site's content script.
    if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(page())) return false;
    const r = relays.get(m.rid);
    if (m.t === 'signin.get') {
      answer(r ? r.view : { state: 'gone' });
      return false;
    }
    if (!r) return void answer({ state: 'gone' });
    if (m.t === 'signin.shown') {
      if (r.shown !== m.state) up({ t: 'signin.shown', rid: m.rid, state: String(m.state || '').slice(0, 20) });
      r.shown = m.state;
      return false;
    }
    if (m.t === 'signin.pick' && typeof m.account === 'string') {
      r.view = { ...r.view, state: 'waiting', account: m.account };
      up({ t: 'signin.pick', rid: m.rid, account: m.account, remember: m.remember === true });
    } else if (m.t === 'signin.here') {
      // Let the provider's own page load in this tab, as if nothing were here.
      through.set(r.tabId, Date.now() + 10 * 60_000);
      drop(m.rid);
      up({ t: 'signin.closed', rid: m.rid, why: 'here' });
      blockRules().then(() => chrome.tabs.update(r.tabId, { url: r.url }).catch(() => {}));
    } else if (m.t === 'signin.cancel') {
      drop(m.rid);
      up({ t: 'signin.closed', rid: m.rid, why: 'cancelled' });
      chrome.tabs.get(r.tabId).then((t) => (t.openerTabId !== undefined ? chrome.tabs.remove(r.tabId) : chrome.tabs.goBack(r.tabId))).catch(() => {});
    }
    answer(r.view);
    return false;
  }

  // ------------------------------------------------------------ answering
  async function authorize(id, cmd) {
    const url = String(cmd.url || '');
    const redirect = String(cmd.redirect || '');
    if (!/^https?:\/\/[^\s*^|]+$/.test(redirect) || !url) return reply(id, false, 'no link to open');
    const ms = Math.max(5000, Math.min(Number(cmd.ms) || 120000, 600000));
    const rule = 9000 + (++seq % 50000);
    const aid = typeof cmd.aid === 'string' ? cmd.aid.slice(0, 80) : null;
    let tab = null;
    let finished = false;
    const isAnswer = (u) => typeof u === 'string' && u.startsWith(redirect) && /^([?#]|$)/.test(u.slice(redirect.length));
    const finish = async (ok, v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (chrome.webNavigation) {
        chrome.webNavigation.onBeforeNavigate.removeListener(onNav);
        chrome.webNavigation.onErrorOccurred.removeListener(onNav);
      }
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule] });
      } catch (e) {}
      if (aid) answerTabs.delete(aid);
      if (tab) {
        answering.delete(tab.id);
        try {
          // Never the browser's last tab: that would close its window.
          const all = await chrome.tabs.query({});
          if (all.length > 1) await chrome.tabs.remove(tab.id);
          else await chrome.tabs.update(tab.id, { url: 'about:blank' });
        } catch (e) {}
      }
      reply(id, ok, v);
    };
    const mine = (tabId) => tab && tabId === tab.id;
    const onUpdated = (tabId, info) => mine(tabId) && info.url && isAnswer(info.url) && finish(true, { url: info.url });
    const onNav = (d) => mine(d.tabId) && d.frameId === 0 && isAnswer(d.url) && finish(true, { url: d.url });
    const onRemoved = (tabId) => mine(tabId) && finish(false, 'the sign-in tab was closed');
    const timer = setTimeout(() => finish(false, `no answer in ${Math.round(ms / 1000)} s`), ms);
    try {
      tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      answering.add(tab.id);
      if (aid) answerTabs.set(aid, tab.id);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      if (chrome.webNavigation) {
        chrome.webNavigation.onBeforeNavigate.addListener(onNav);
        chrome.webNavigation.onErrorOccurred.addListener(onNav);
      }
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [rule],
        addRules: [{ id: rule, priority: 1, action: { type: 'block' }, condition: { urlFilter: '|' + redirect, resourceTypes: ['main_frame'], tabIds: [tab.id] } }],
      });
      await chrome.tabs.update(tab.id, { url, active: true });
      if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch (e) {
      finish(false, 'could not open the sign-in: ' + ((e && e.message) || e));
    }
  }

  /**
   * Which of the provider's screens a page shows, run in the answering tab (chrome.scripting; it must stand alone).
   * `choose`: its account chooser, and where `who` is in it. `consent`: a screen whose one way on is Continue (or
   * Allow), and where that button is. Anything else (a password, a code, a check, a chooser without `who`) is `other`:
   * the person's, in the live view. Points are on the screen: the window's frame added (as the browser interface does).
   */
  function providerPage(who) {
    if (document.readyState !== 'complete') return { step: 'loading' };
    if (document.hidden) return { step: 'hidden' };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const at = (el, step) => {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const cx = Math.max(1, Math.min(innerWidth - 2, r.left + r.width / 2));
      const cy = Math.max(1, Math.min(innerHeight - 2, r.top + Math.min(r.height / 2, 20)));
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) return { step: 'other', why: 'covered' };
      const side = (outerWidth - innerWidth) / 2;
      const above = outerHeight - innerHeight - side;
      return { step, x: Math.round(screenX + side + cx), y: Math.round(screenY + above + cy) };
    };
    const words = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if ([...document.querySelectorAll('input[type=password], input[type=tel], input[autocomplete=one-time-code], iframe[src*="recaptcha"]')].some(shown)) return { step: 'other', why: 'asks for something' };
    const me = String(who || '').trim().toLowerCase();
    const accounts = [...document.querySelectorAll('[data-identifier], [data-email]')].filter(shown);
    if (accounts.length) {
      const mine = me && accounts.find((el) => String(el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').trim().toLowerCase() === me);
      return mine ? at(mine, 'choose') : { step: 'other', why: 'not in the chooser' };
    }
    const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(shown);
    const go = [document.getElementById('submit_approve_access'), ...buttons.filter((b) => /^(continue|allow)$/i.test(words(b)))].filter((b) => b && shown(b));
    if (go.length === 1 || (go.length > 1 && go.every((b) => b === go[0] || b.contains(go[0]) || go[0].contains(b)))) return at(go[0], 'consent');
    return { step: 'other', why: go.length ? 'more than one Continue' : 'no Continue' };
  }

  /**
   * Starting a sign-in on the site (signin.ts SignInAsker.start), run in the site's tab (chrome.scripting; it must
   * stand alone): `provider` is a button or link that signs in with the provider (its words or its label name it, as
   * "Continue with Google" does), and where it is on the screen; `login` is the site's own "Sign in" or "Log in", the
   * way to a page that has one; `none` is neither. Google's own drawn button (an iframe of accounts.google.com) is not
   * one: it signs in in a popup the relay does not carry. Points are on the screen, as providerPage's.
   */
  function seekPage(names) {
    if (document.readyState !== 'complete') return { step: 'loading' };
    if (document.hidden) return { step: 'hidden' };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
    };
    const at = (el, step) => {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const cx = Math.max(1, Math.min(innerWidth - 2, r.left + r.width / 2));
      const cy = Math.max(1, Math.min(innerHeight - 2, r.top + Math.min(r.height / 2, 20)));
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) return { step: 'none', why: 'covered' };
      const side = (outerWidth - innerWidth) / 2;
      const above = outerHeight - innerHeight - side;
      return { step, x: Math.round(screenX + side + cx), y: Math.round(screenY + above + cy) };
    };
    const label = (el) =>
      [el.innerText || el.value || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', ...[...el.querySelectorAll('img[alt]')].map((i) => i.alt)]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    const all = [...document.querySelectorAll('button, a[href], [role=button], [role=link], input[type=submit], input[type=button]')].filter(shown);
    const name = new RegExp('\\b(' + names.map((n) => n.replace(/[^\w ]/g, '')).join('|') + ')\\b', 'i');
    // Words a provider's sign-in button says, besides its name; a link to its other services says none of them.
    const signs = /\b(sign|log|continue|connect|join|register|use|with|via)\b/i;
    const ours = all.filter((el) => {
      const w = label(el);
      return w.length <= 60 && name.test(w);
    });
    const best = ours.find((el) => signs.test(label(el))) || ours.find((el) => label(el).replace(name, '').trim() === '');
    if (best) return at(best, 'provider');
    const login = (re) => all.find((el) => re.test(label(el)));
    const way = login(/^(sign ?in|log ?in)$/i) || login(/^(sign ?in|log ?in)\b.{0,12}$/i) || login(/^(sign ?up|get started|join)$/i);
    if (way) return at(way, 'login');
    if (document.querySelector('iframe[src*="accounts.google.com/gsi"]')) return { step: 'none', why: "only Google's own drawn button" };
    return { step: 'none', why: 'no sign-in button' };
  }

  /** The site's tab: the active one in front that is not a chooser or a provider's tab of ours. */
  async function siteTab() {
    const front = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const all = front.length ? front : await chrome.tabs.query({ active: true });
    return all.find((t) => !byTab.has(t.id) && !answering.has(t.id) && /^https?:/.test(t.url || t.pendingUrl || '')) || null;
  }

  async function seek(id, cmd) {
    try {
      const t = await siteTab();
      if (!t) return reply(id, true, { step: 'none', why: 'no site tab in front' });
      if (t.status === 'loading') return reply(id, true, { step: 'loading' });
      const names = (Array.isArray(cmd.names) ? cmd.names : []).map((n) => String(n).slice(0, 30)).filter(Boolean);
      if (!names.length) return reply(id, false, 'no provider named');
      const res = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: seekPage, args: [names] });
      reply(id, true, (res && res[0] && res[0].result) || { step: 'none', why: 'unreadable' });
    } catch (e) {
      reply(id, true, { step: 'none', why: 'unreadable' });
    }
  }

  async function look(id, cmd) {
    const tabId = answerTabs.get(cmd.aid);
    if (tabId === undefined) return reply(id, true, { step: 'gone' });
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'loading') return reply(id, true, { step: 'loading' });
      if (!t.active) return reply(id, true, { step: 'hidden' });
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: providerPage, args: [String(cmd.who || '')] });
      reply(id, true, (res && res[0] && res[0].result) || { step: 'other', why: 'unreadable' });
    } catch (e) {
      reply(id, true, { step: 'other', why: 'unreadable' });
    }
  }

  // ------------------------------------------------------------ the extractor's commands
  function command(msg) {
    const cmd = (msg && msg.cmd) || {};
    if (typeof cmd.kind !== 'string' || !cmd.kind.startsWith('signin.')) return false;
    const r = relays.get(cmd.rid);
    if (cmd.kind === 'signin.authorize') {
      authorize(msg.id, cmd);
      return true;
    }
    if (cmd.kind === 'signin.look') {
      look(msg.id, cmd);
      return true;
    }
    if (cmd.kind === 'signin.seek') {
      seek(msg.id, cmd);
      return true;
    }
    if (!r) {
      reply(msg.id, false, 'that sign-in is over');
      return true;
    }
    if (cmd.kind === 'signin.show') {
      r.view = { ...(cmd.view || {}), name: r.name };
      reply(msg.id, true, { shown: true });
    } else if (cmd.kind === 'signin.done') {
      const to = String(cmd.url || '');
      drop(cmd.rid);
      chrome.tabs.update(r.tabId, { url: to }).then(
        () => reply(msg.id, true, { loaded: true }),
        (e) => reply(msg.id, false, 'the tab went away'),
      );
    } else if (cmd.kind === 'signin.failed') {
      r.view = { ...r.view, ...(cmd.view || {}), state: 'failed', error: String(cmd.error || 'it did not work').slice(0, 300) };
      reply(msg.id, true, { shown: true });
    } else reply(msg.id, false, 'no such sign-in command');
    return true;
  }

  /** At the worker's top level, so its listeners are there when an event wakes it; `cfg` may be a promise. */
  function start(sendUp, cfg) {
    up = sendUp;
    Promise.resolve(cfg).then(
      (c) => {
        consume = (c && Array.isArray(c.consume) ? c.consume : []).filter((p) => p && Array.isArray(p.origins) && Array.isArray(p.paths));
        blockRules();
      },
      () => {},
    );
    chrome.runtime.onMessage.addListener(fromChooser);
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (through.delete(tabId)) blockRules();
      const rid = byTab.get(tabId);
      if (rid) {
        drop(rid);
        up({ t: 'signin.closed', rid, why: 'closed' });
      }
    });
    chrome.tabs.onCreated.addListener((t) => watch(t.id, t.pendingUrl || t.url));
    chrome.tabs.onUpdated.addListener((tabId, info) => info.url && watch(tabId, info.url));
    if (chrome.webNavigation) {
      chrome.webNavigation.onBeforeNavigate.addListener((d) => d.frameId === 0 && watch(d.tabId, d.url));
      chrome.webNavigation.onCommitted.addListener((d) => d.frameId === 0 && watch(d.tabId, d.url));
    }
  }

  return { start, command, owns: (tabId) => byTab.has(tabId) || answering.has(tabId) };
})();
