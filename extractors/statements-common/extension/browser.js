
/*
 * The `browser` interface's part of the worker (docs/browser.md), appended to driver.js in every copy. It adds:
 *
 *   tab.info   a tab's whole URL, title and whether it is in front
 *   tab.front  bring a tab to the front of a focused window (real input goes to what is in front)
 *   page.call  one of the page functions below, in the tab's top frame, in this extension's isolated world
 *
 * The page functions read the page and find where an element is on the screen; they never click, type or change
 * the page themselves. The extractor does the input with real mouse and key events on the display. Refs (e1, e2…)
 * live in the isolated world (the page can't see them) until the next read or a page load.
 */
const BROWSER_PAGE = {
  /** The visible text and the interactive elements, each with a ref. */
  read: function (maxText, maxElements, guardSrc) {
    const GUARD = new RegExp(guardSrc, 'i');
    const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    };
    const roleOf = (el) => {
      const r = el.getAttribute('role');
      if (r) return r;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (ty === 'checkbox' || ty === 'radio') return ty;
        if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return tag;
    };
    const nameOf = (el) => {
      const by = el.getAttribute('aria-labelledby');
      const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '';
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      const isField = el.tagName === 'INPUT' && !['submit', 'button', 'reset', 'image'].includes((el.type || '').toLowerCase());
      const img = el.querySelector && el.querySelector('img[alt]');
      return squash(
        el.getAttribute('aria-label') ||
          labelled ||
          label ||
          (isField ? el.placeholder || el.title || el.name : el.innerText || el.value) ||
          (img && img.alt) ||
          el.title ||
          '',
      );
    };
    const SEL = [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
      '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]', '[role=option]',
      '[role=combobox]', '[role=switch]', '[role=textbox]', '[contenteditable=""]', '[contenteditable=true]',
    ].join(',');
    const refs = new Map();
    globalThis.__browserRefs = refs;
    const elements = [];
    let elementsCut = false;
    let n = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (!shown(el)) continue;
      if (elements.length >= maxElements) {
        elementsCut = true;
        break;
      }
      const ref = `e${++n}`;
      refs.set(ref, new WeakRef(el));
      const role = roleOf(el);
      const name = cut(nameOf(el), 120);
      const r = el.getBoundingClientRect();
      const e = { ref, role, name, inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth };
      if (role === 'checkbox' || role === 'radio') e.value = String(el.checked ?? el.getAttribute('aria-checked') === 'true');
      else if (el.tagName === 'SELECT') e.value = squash(el.selectedOptions[0]?.text);
      else if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password') e.value = el.value ? '(filled)' : '';
      else if (role === 'textbox' && typeof el.value === 'string') e.value = cut(el.value, 200);
      if (el.tagName === 'A' && el.href) e.href = el.href;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true;
      if ((role === 'button' || role === 'link' || role === 'menuitem') && GUARD.test(name)) e.guarded = true;
      elements.push(e);
    }
    const text = document.body ? document.body.innerText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() : '';
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0, maxText),
      textCut: text.length > maxText,
      elements,
      elementsCut,
    };
  },

  /** Scroll a ref's element into the window and say where its middle is on the screen. */
  point: function (ref, guardSrc) {
    const w = globalThis.__browserRefs && globalThis.__browserRefs.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) return { error: `no element ${ref} on this page now: read the page again` };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { error: `${ref} is not shown` };
    const cx = Math.max(1, Math.min(innerWidth - 2, r.left + r.width / 2));
    const cy = Math.max(1, Math.min(innerHeight - 2, r.top + Math.min(r.height / 2, 20)));
    const top = document.elementFromPoint(cx, cy);
    const covered = top && top !== el && !el.contains(top) && !top.contains(el);
    // The window's frame: Chromium's toolbars above the page, a border (0 here) on each side.
    const side = (outerWidth - innerWidth) / 2;
    const above = outerHeight - innerHeight - side;
    const name = String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      x: Math.round(screenX + side + cx),
      y: Math.round(screenY + above + cy),
      guarded: new RegExp(guardSrc, 'i').test(name),
      name,
      tag: el.tagName.toLowerCase(),
      covered: covered ? String(top.tagName).toLowerCase() : null,
    };
  },

  /** Whether the focused element is one only browser.press may press. */
  focused: function (guardSrc) {
    const el = document.activeElement;
    if (!el || el === document.body) return { guarded: false, name: '' };
    const name = String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const pressable = /^(BUTTON|A|SUMMARY)$/.test(el.tagName) || (el.tagName === 'INPUT' && /^(submit|button|image)$/i.test(el.type)) || /^(button|link|menuitem)$/.test(el.getAttribute('role') || '');
    return { guarded: pressable && new RegExp(guardSrc, 'i').test(name), name };
  },

  /** Pick a <select>'s option by its text or value (the one change made from the page: a native select's list is a popup outside it). */
  select: function (ref, option) {
    const w = globalThis.__browserRefs && globalThis.__browserRefs.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) return { error: `no element ${ref} on this page now: read the page again` };
    if (el.tagName !== 'SELECT') return { error: `${ref} is not a select: click it and click the option instead` };
    const want = String(option).trim().toLowerCase();
    const o = [...el.options].find((x) => x.value.toLowerCase() === want || x.text.trim().toLowerCase() === want) || [...el.options].find((x) => x.text.trim().toLowerCase().startsWith(want));
    if (!o) return { error: `no option "${option}": ${[...el.options].map((x) => x.text.trim()).slice(0, 30).join(', ')}` };
    el.focus();
    el.value = o.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { chosen: o.text.trim() };
  },

  /** What the page asks only a person to do, when it looks like a captcha, a checkpoint or a code. */
  challenge: function () {
    const q = 'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="arkoselabs"],iframe[src*="funcaptcha"],iframe[src*="challenges.cloudflare.com"],#captchacharacters,form[action*="validateCaptcha"]';
    if (document.querySelector(q)) return 'a captcha';
    const p = location.pathname;
    if (/validatecaptcha|\/ap\/cvf|\/checkpoint|\/challenge/i.test(p)) return 'a checkpoint';
    const t = document.body ? document.body.innerText.slice(0, 4000) : '';
    const m = t.match(/\bI am human\b|verify (that )?you('re| are) (a )?human|enter the characters you see|unusual (browser )?activity|enter (the )?(verification|security|one-time) code|we('ve| have) sent (you )?(a|an) (code|OTP)/i);
    return m ? m[0] : null;
  },
};

EXTRA['tab.info'] = async (cmd) => {
  const t = await chrome.tabs.get(cmd.tabId);
  return { tabId: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', active: !!t.active, status: t.status };
};
EXTRA['tab.front'] = async (cmd) => {
  const t = await chrome.tabs.update(cmd.tabId, { active: true });
  try {
    await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) {}
  return { tabId: t.id, active: true };
};
EXTRA['page.call'] = async (cmd) => {
  const fn = BROWSER_PAGE[cmd.fn];
  if (typeof fn !== 'function') throw new Error(`no browser page function ${cmd.fn}`);
  // executeScript sends the function's source alone: each page function above stands on its own.
  const res = await chrome.scripting.executeScript({ target: { tabId: cmd.tabId, frameIds: [0] }, world: 'ISOLATED', func: fn, args: cmd.args || [] });
  return res && res[0] ? res[0].result : undefined;
};
