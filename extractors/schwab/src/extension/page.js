/*
 * The Schwab kind's page functions, run by sw.js (statements-common's driver) with chrome.scripting in the page's
 * isolated world: they read the page and press its own controls, as you would: pick the account, set the date range,
 * press Export (and, if Schwab asks which format, CSV). The file Schwab sends lands in the browser's Downloads, where
 * the extractor picks it up. Nothing here reads what you type, fills a password or answers a code; nothing here pays,
 * trades or transfers: the only controls pressed are the account picker, the date range, Search and Export, and on the
 * sign-in page the passkey option.
 *
 * Controls are found by what they say (their text, label, aria-label or placeholder), not by Schwab's markup, so a
 * restyled page still works when its words stay; `describe` lists the controls when one is not found, for the log.
 * On the sign-in page, `passkey` finds (and on the extractor's word clicks) Schwab's passkey option, the one thing it
 * presses there: the passkey itself is answered by the extractor (hook.js, docs/schwab.md).
 * Each function is self-contained: it is serialized into the page.
 */
self.PAGE = {
  /** Where the page is: a code being asked for, a sign-in form, the account picker's accounts, Export, loading. */
  probe: () => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const text = (document.body && document.body.innerText) || '';
    // A field for a code (otp), or words asking for one or for an approval on the phone.
    const otp = [...document.querySelectorAll('input')].some((i) => vis(i) && i.type !== 'hidden' && i.type !== 'password' && (i.autocomplete === 'one-time-code' || /\b(otp|passcode|security.?code|verification.?code|one.?time)\b/i.test(`${i.name} ${i.id} ${i.getAttribute('aria-label') || ''} ${i.placeholder || ''}`)));
    const challenge =
      otp ||
      /verify (it'?s|that it'?s) you|security code|verification code|enter the code|we sent (a|you a) code|approve (the|this) (sign.?in|login)|two-step|2-step|confirm your identity/i.test(text);
    const password = [...document.querySelectorAll('input[type=password]')].some(vis) || [...document.querySelectorAll('iframe')].some((f) => vis(f) && /login|signon|gateway|lms/i.test(`${f.src} ${f.id} ${f.name} ${f.title}`));
    const MASK = /(?:…|\.\.\.|\bX{2,}-?)\s?(\d{3,4})\b/;
    const accounts = new Map();
    for (const el of document.querySelectorAll('option, [role=option], [role=menuitem], li, button, a, [aria-haspopup]')) {
      const own = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!own || own.length > 80) continue;
      const m = MASK.exec(own);
      if (!m) continue;
      const mask = m[1].slice(-3);
      const selected = (el.tagName === 'OPTION' && el.selected) || el.getAttribute('aria-selected') === 'true' || el.hasAttribute('aria-haspopup') || el.getAttribute('aria-expanded') !== null;
      const prev = accounts.get(mask);
      accounts.set(mask, { mask, label: (prev && prev.label) || own.replace(/\$[\d,.]+/g, '').trim().slice(0, 60), selected: (prev && prev.selected) || selected });
    }
    const clickable = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], input[type=button], input[type=submit]')].filter(vis);
    const label = (el) => `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`.replace(/\s+/g, ' ').trim();
    const exportable = clickable.some((el) => /^export\b|\bexport$|download (csv|transactions)/i.test(label(el)));
    const loading = [...document.querySelectorAll('[aria-busy=true], [role=progressbar], .spinner, .loading, .loader')].some(vis) || /^\s*loading\.*\s*$/im.test(text.slice(0, 2000));
    const found = /transactions? found|no transactions|realized gain|gain\/loss/i.test(text);
    return { challenge, otp, password, accounts: [...accounts.values()], exportable, loading, found, title: document.title.slice(0, 80) };
  },

  /**
   * Schwab's passkey sign-in option in this frame: the control whose accessible name says "passkey" (buttons and links
   * that are visible and enabled; the name from aria-labelledby, aria-label, text, value, title and images' alt). One
   * that says sign in, log in, use or continue with a passkey comes first; links about passkeys (learn, add, manage)
   * never count. With `click`, it is clicked (what you would click; nothing else is pressed or typed). Also says
   * whether a captcha shows (an invisible reCAPTCHA badge does not count).
   */
  passkey: (click) => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) !== 0;
    const name = (el) => {
      const by = (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const t = document.getElementById(id);
          return t ? t.innerText || t.textContent || '' : '';
        })
        .join(' ');
      const alt = [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ');
      return `${by} ${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''} ${el.tagName === 'INPUT' ? el.value || '' : ''} ${el.title || ''} ${alt}`.replace(/\s+/g, ' ').trim();
    };
    const all = [...document.querySelectorAll('button, a, [role=button], [role=link], input[type=button], input[type=submit]')]
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && vis(el))
      .map((el) => ({ el, n: name(el) }))
      .filter((x) => /passkey/i.test(x.n) && !/learn|what is|about passkeys|\badd\b|create|set ?up|manage|remove|delete/i.test(x.n));
    const best = all.find((x) => x.el.tagName !== 'A' && /(log|sign)\s*(in|on)|\buse\b|continue|with (a |your )?passkey/i.test(x.n)) || all.find((x) => x.el.tagName !== 'A') || all[0];
    const CAPTCHA = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i;
    const text = (document.body && document.body.innerText) || '';
    const captcha =
      [...document.querySelectorAll('iframe')].some((f) => CAPTCHA.test(f.src || '') && !/size=invisible/.test(f.src || '') && vis(f)) ||
      [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')].some(vis) ||
      /verify (that )?you('| a)re (a )?human|are you a robot|complete the captcha/i.test(text);
    let clicked = false;
    if (click && best) {
      best.el.click();
      clicked = true;
    }
    return { passkey: !!best, captcha, clicked };
  },

  /** The controls on the page, by kind and what they say (no values, nothing with a $ amount), for the log. */
  describe: () => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const out = [];
    for (const el of document.querySelectorAll('button, a, [role=button], [role=tab], [role=combobox], [aria-haspopup], select, input, label')) {
      if (!vis(el) || out.length >= 80) continue;
      let s = el.tagName === 'INPUT' ? `${el.type}:${el.getAttribute('aria-label') || el.placeholder || el.name || el.id}` : el.tagName === 'SELECT' ? `select:${el.getAttribute('aria-label') || el.name || el.id}[${[...el.options].map((o) => o.text.trim()).join('|')}]` : `${el.tagName.toLowerCase()}:${(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()}`;
      s = s.replace(/[+-]?\$[\d,.]+/g, '$…').slice(0, 70);
      if (!/:\s*$/.test(s)) out.push(s);
    }
    return out;
  },

  /**
   * The page's own links whose text (or aria-label) matches `pattern` (case-insensitive), visible or in a closed menu,
   * inside open shadow roots too:
   * their URLs (origin, path and hash; no query), for finding a page by what the site's navigation calls it.
   */
  links: (pattern) => {
    const re = new RegExp(pattern, 'i');
    const out = [];
    const deep = (root) => {
      const out = [...root.querySelectorAll('a[href]')];
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deep(el.shadowRoot));
      return out;
    };
    // Schwab's menu (responsive-meganav) is a web component: its links are in shadow roots.
    for (const a of deep(document)) {
      const t = `${a.innerText || a.textContent || ''} ${a.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
      if (!re.test(t)) continue;
      try {
        const u = new URL(a.href, location.href);
        if (u.protocol === 'https:' || u.protocol === 'http:') out.push({ text: t.replace(/[+-]?\$[\d,.]+/g, '$…').slice(0, 60), url: u.origin + u.pathname + u.hash });
      } catch (e) {}
    }
    return out.slice(0, 80);
  },

  /**
   * For the log when a step finds nothing: the page's date controls, looking inside open shadow roots too. Inputs that
   * are not checkboxes or radios (type, visible, what they say, and a value only when it is a date), controls whose
   * text or label is about dates, and the custom elements present. Amounts are masked; nothing else is read.
   */
  dateOutline: () => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const mask = (t) => t.replace(/[+-]?\$[\d,.]+/g, '$…').replace(/\s+/g, ' ').trim();
    const DATE = /\bdates?\b|range|\bfrom\b|\bto\b|month|year|custom|period|calendar|start|end|mm\/dd/i;
    const inputs = [];
    const controls = [];
    const tags = new Set();
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes('-')) tags.add(tag);
      const label = mask(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('name') || ''} ${el.id || ''}`);
      if (tag === 'input' && !/^(checkbox|radio|hidden)$/.test(el.type)) {
        const v = /^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(el.value || '') ? ` =${el.value}` : '';
        inputs.push(`${el.type}${vis(el) ? '' : '(hidden)'}${el.getRootNode() !== document ? '(shadow)' : ''}:${label.slice(0, 60)}${v}`);
      } else if (/^(button|select|a)$/.test(tag) || el.getAttribute('role') || el.hasAttribute('aria-expanded') || tag.includes('-')) {
        const own = mask(el.children.length ? el.getAttribute('aria-label') || '' : el.innerText || el.textContent || '');
        const t = `${own} ${label}`;
        if (DATE.test(t) && controls.length < 40) controls.push(`${tag}${vis(el) ? '' : '(hidden)'}${el.getRootNode() !== document ? '(shadow)' : ''}${el.getAttribute('aria-expanded') !== null ? `[expanded=${el.getAttribute('aria-expanded')}]` : ''}:${t.slice(0, 70)}`);
      }
    }
    // The date picker's structure: tags and attributes (no text but short labels), shadow roots included.
    const shape = (el, depth) => {
      if (!el || depth > 7) return '';
      const attrs = [...el.attributes].filter((x) => !/^(style|_ngcontent|_nghost)/.test(x.name)).map((x) => `${x.name}=${String(x.value).slice(0, 40)}`).join(' ');
      const kids = [...el.children, ...(el.shadowRoot ? [...el.shadowRoot.children] : [])];
      const own = !el.children.length ? mask(el.textContent || '').slice(0, 30) : '';
      return `<${el.tagName.toLowerCase()} ${attrs}>${own}${kids.map((k) => shape(k, depth + 1)).join('')}</>`;
    };
    const picker = all.find((el) => el.tagName === 'APP-DATE-PICKER');
    const pickerShape = picker ? shape(picker, 0).slice(0, 3000) : null;
    const selects = all.filter((el) => el.tagName === 'SELECT').map((el) => `${el.id || el.name}${vis(el) ? '' : '(hidden)'}=${el.value}[${[...el.options].map((o) => `${o.value}:${o.text.trim()}`).join('|')}]`.slice(0, 400));
    return { pickerShape, selects, inputs: inputs.slice(0, 40), controls, tags: [...tags].slice(0, 60), text: mask((document.body.innerText || '').match(/[^\n]*(date range|from|custom|last \d+|previous|current)[^\n]*/gi)?.slice(0, 10).join(' | ') || '').slice(0, 600) };
  },

  /** The sentence that says which dates the page shows ("Transactions found from … to …"), masked, or ''. */
  shown: () => {
    const m = ((document.body && document.body.innerText) || '').match(/[^\n]*\bfrom\s+\d{2}\/\d{2}\/\d{4}\s+to\s+\d{2}\/\d{2}\/\d{4}[^\n]*/i);
    return m ? m[0].replace(/[+-]?\$[\d,.]+/g, '$…').slice(0, 200) : '';
  },

  /** Pick the account ending in `mask` in the page's account picker. */
  selectAccount: async (mask) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const has = (s) => new RegExp(`(?:…|\\.\\.\\.|X{2,}-?)\\s?\\d*${mask}\\b`).test(s);
    const press = (el) => {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      el.click();
    };
    for (const sel of document.querySelectorAll('select')) {
      const o = [...sel.options].find((o) => has(o.text));
      if (!o) continue;
      if (sel.value === o.value) return { ok: true, how: 'select', already: true };
      sel.value = o.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, how: 'select' };
    }
    const items = () => [...document.querySelectorAll('[role=option], [role=menuitem], [role=menuitemradio], li, a, button')].filter((el) => vis(el) && has((el.innerText || '').replace(/\s+/g, ' ')) && !el.hasAttribute('aria-haspopup'));
    const toggle = [...document.querySelectorAll('[aria-haspopup], [aria-expanded], [role=combobox]')].find((el) => vis(el) && /(?:…|\.\.\.|X{2,})\s?\d{3,4}/.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (toggle && has(toggle.innerText || toggle.getAttribute('aria-label') || '') && !items().length) return { ok: true, how: 'menu', already: true };
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
      press(toggle);
      await sleep(600);
    }
    const it = items()[0];
    if (!it) return { ok: false, how: toggle ? 'menu: no item for the account' : 'no account picker' };
    press(it);
    return { ok: true, how: 'menu' };
  },

  /** Set the page's date range to from..to (mm/dd/yyyy): "Custom" if it has one, the From and To fields, then Search. */
  setRange: async (from, to) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const press = (el) => {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      el.click();
    };
    const said = (el) => {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean);
      const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return `${el.getAttribute('aria-label') || ''} ${el.placeholder || ''} ${el.name || ''} ${el.id || ''} ${lab ? lab.innerText : ''} ${ids.map((e) => e.innerText).join(' ')} ${(el.closest('label') || {}).innerText || ''}`.toLowerCase();
    };
    let custom = false;
    for (const sel of document.querySelectorAll('select')) {
      const o = [...sel.options].find((o) => /custom/i.test(o.text));
      if (!o) continue;
      if (sel.value !== o.value) {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
      }
      custom = true;
      break;
    }
    if (!custom) {
      const opener = [...document.querySelectorAll('button, [role=button], [role=combobox], [aria-haspopup]')].find((el) => vis(el) && /date range|custom|last \d+ (days|months)|current month|previous month|year to date|\bytd\b|\d{1,2}\/\d{1,2}\/\d{2,4}/i.test(el.innerText || el.getAttribute('aria-label') || ''));
      if (opener) {
        press(opener);
        await sleep(500);
        const opt = [...document.querySelectorAll('[role=option], [role=menuitem], [role=radio], li, button, label')].find((el) => vis(el) && /^\s*custom( date range)?\s*$/i.test(el.innerText || ''));
        if (opt) {
          press(opt);
          await sleep(500);
          custom = true;
        }
      }
    }
    const inputs = [...document.querySelectorAll('input')].filter((i) => vis(i) && /^(text|date|tel|)$/.test(i.type));
    const fromEl = inputs.find((i) => /\b(from|start)\b/.test(said(i))) || inputs.filter((i) => /mm\/dd\/yyyy/.test(said(i)))[0];
    const toEl = inputs.find((i) => /\b(to|end)\b/.test(said(i)) && i !== fromEl) || inputs.filter((i) => /mm\/dd\/yyyy/.test(said(i)))[1];
    if (!fromEl || !toEl) {
      // What there was, for the log: every input (visible or not) by type and what it says, and the openers tried.
      const seen = [...document.querySelectorAll('input')].filter((i) => i.type !== 'hidden').slice(0, 30).map((i) => `${i.type}${vis(i) ? '' : '(hidden)'}:${said(i).replace(/\s+/g, ' ').trim().slice(0, 50)}`);
      const openers = [...document.querySelectorAll('button, [role=button], [role=combobox], [aria-haspopup], select')].filter(vis).map((el) => `${el.tagName.toLowerCase()}:${(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()}`.replace(/[+-]?\$[\d,.]+/g, '$…').slice(0, 50)).filter((x) => !/:$/.test(x)).slice(0, 40);
      return { ok: false, how: `no From/To fields${custom ? ' after Custom' : ''}`, seen, openers };
    }
    const put = (el, v) => {
      el.focus();
      el.value = el.type === 'date' ? `${v.slice(6)}-${v.slice(0, 2)}-${v.slice(3, 5)}` : v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    put(fromEl, from);
    put(toEl, to);
    await sleep(300);
    const go = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].find((el) => vis(el) && !el.disabled && /^(search|apply|update|go|view)$/i.test((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()));
    if (!go) return { ok: false, how: 'no Search button' };
    press(go);
    return { ok: true, how: custom ? 'custom' : 'fields' };
  },

  /**
   * Press Export; if Schwab asks which format, choose CSV and confirm. Schwab's History opens its own export dialog
   * (app-export-modal in an sdps-modal web component: CSV / JSON radios, then an Export button), so the dialog, its
   * radios and its buttons are looked for inside open shadow roots too. When it finds no way on, it says what the
   * dialog held (tags, ids, labels; no values), for the log.
   */
  exportNow: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const press = (el) => {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: window }));
      el.click();
    };
    const deep = (root, sel) => {
      const out = [...root.querySelectorAll(sel)];
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deep(el.shadowRoot, sel));
      return out;
    };
    const label = (el) => `${el.innerText || el.value || el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`.replace(/\s+/g, ' ').trim();
    const CLICK = 'button, a, [role=button], [role=menuitem], input[type=button], input[type=submit], sdps-button';
    const clickable = (root) => deep(root || document, CLICK).filter((el) => vis(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    // An sdps-button's real <button> is in its shadow root: press that one.
    const real = (el) => (el.tagName === 'SDPS-BUTTON' && el.shadowRoot && el.shadowRoot.querySelector('button')) || el;
    const ex = clickable().find((el) => /^export\b|\bexport$/i.test(label(el)) && !el.closest('app-export-modal, sdps-modal, [role=dialog]')) || clickable().find((el) => /download (csv|transactions)/i.test(label(el)));
    if (!ex) return { ok: false, how: 'no Export control' };
    press(real(ex));
    const dialogOf = () =>
      deep(document, 'app-export-modal, [role=dialog], [role=alertdialog], dialog[open], .modal, sdps-modal').find((d) => vis(d) && (deep(d, 'input[type=radio], [role=radio]').some(vis) || clickable(d).length));
    let dialog = null;
    for (let i = 0; i < 12 && !dialog; i++) {
      await sleep(250);
      dialog = dialogOf();
    }
    if (!dialog) {
      // A menu of formats instead of a dialog.
      const csv = clickable().find((el) => /^\s*(csv|export to csv|\.csv)\s*$/i.test(label(el)));
      if (csv) press(real(csv));
      return { ok: true, how: csv ? 'menu' : 'direct' };
    }
    const radios = deep(dialog, 'input[type=radio], [role=radio]');
    // What a radio says: its own words, its label, and the card around it (the nearest ancestor holding no other radio:
    // Realized Gain/Loss's choices are cards, "Export Summary Only" / "Export Details Only").
    const cardOf = (r) => {
      let el = r;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        const up = el.parentElement;
        if (radios.filter((x) => up.contains(x)).length > 1) break;
        el = up;
      }
      return el;
    };
    const radioText = (r) => `${r.value || ''} ${r.id || ''} ${r.getAttribute('aria-label') || ''} ${r.id ? (document.querySelector(`label[for="${CSS.escape(r.id)}"]`) || {}).innerText || '' : ''} ${cardOf(r).innerText || cardOf(r).textContent || ''}`;
    // CSV (History: CSV or JSON); else the details, lot by lot (Realized Gain/Loss: summary or details).
    const radio = radios.find((r) => /csv/i.test(radioText(r))) || radios.find((r) => /details/i.test(radioText(r)) && !/summary/i.test(radioText(r)));
    if (radio && !radio.checked && radio.getAttribute('aria-checked') !== 'true') {
      const lab = radio.id ? deep(dialog, `label[for="${CSS.escape(radio.id)}"]`)[0] : null;
      // What you would click: its label, the radio, or (a radio drawn by the page) its card.
      press(lab && vis(lab) ? lab : vis(radio) ? radio : cardOf(radio));
      if (!radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    }
    await sleep(300);
    const ok = clickable(dialog).filter((el) => /^(export|download|ok|continue|submit)$/i.test(label(el)));
    const btn = ok.find((el) => el.tagName === 'BUTTON') || ok[0];
    if (!btn) {
      const what = clickable(dialog).map((el) => `${el.tagName.toLowerCase()}:${label(el).slice(0, 30)}`).slice(0, 15);
      return { ok: false, how: `dialog without an Export button (${dialog.tagName.toLowerCase()}; radios ${radios.length}, csv ${!!radio}; buttons ${what.join(', ') || 'none'})` };
    }
    press(real(btn));
    return { ok: true, how: `dialog ${dialog.tagName.toLowerCase()}${radio ? `, chose ${/csv/i.test(radioText(radio)) ? 'CSV' : 'details'}` : `, no choice of ${radios.length}`}` };
  },
};
