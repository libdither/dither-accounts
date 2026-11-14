/*
 * The claude kind's page functions, run by sw.js (statements-common's driver) with chrome.scripting in the account's
 * own tab, in the extension's isolated world (the page's scripts never see them). Each is self-contained (it is
 * serialized into the page). They read the page's structure and press its buttons; the only value they type is the
 * account's email, handed in for that one step. They never read a chat.
 */
self.PAGE = {
  /** Where the tab is and what it shows: an email form, "check your email", a consent button, Cloudflare's check. */
  probe: () => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis).map(label).filter(Boolean);
    const email = [...document.querySelectorAll('input[type=email], input[name=email], input#email, input[autocomplete=email]')].find(vis);
    const text = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, 20000);
    return {
      path: location.pathname,
      title: document.title.slice(0, 100),
      challenge:
        document.title === 'Just a moment...' ||
        !!document.querySelector("iframe[src*='challenges.cloudflare.com'], #challenge-form, .cf-turnstile, [name='cf-turnstile-response']"),
      emailField: !!email,
      // The page that follows the email button: its own words, or its "try sending again" / "change email" buttons.
      checkEmail:
        /check your (email|inbox)|we(['\u2019]ve| have)? sent|sent (you )?(a|an) (sign[- ]?in |login |magic |secure )?(link|email)/.test(text) ||
        buttons.some((t) => /try sending again|resend|change email address/i.test(t)),
      authorize: buttons.some((t) => /^(authorize|allow|approve)$/i.test(t)),
      buttons: buttons.slice(0, 20),
    };
  },

  /** Who claude.ai says is signed in, from its own API (the page's cookies): the email and the plan tiers only. */
  whoami: async () => {
    const pick = (j) => {
      const a = (j && (j.account || j)) || {};
      const email = a.email_address || a.email || null;
      const tiers = (a.memberships || [])
        .map((m) => m && m.organization && m.organization.rate_limit_tier)
        .filter((x) => typeof x === 'string');
      return { email: typeof email === 'string' ? email : null, tiers };
    };
    for (const path of ['/api/account', '/api/bootstrap']) {
      try {
        const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
        if (r.status === 401 || r.status === 403) return { signedIn: false, email: null, tiers: [], status: r.status };
        if (!r.ok) continue;
        const p = pick(await r.json());
        if (p.email) return { signedIn: true, email: p.email, tiers: p.tiers, status: r.status, via: path };
      } catch (e) {}
    }
    return { signedIn: null, email: null, tiers: [], status: 0 };
  },

  /** Type the email into the sign-in form (as typing does) and press its email button. */
  enterEmail: (value) => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const f = [...document.querySelectorAll('input[type=email], input[name=email], input#email, input[autocomplete=email]')].find(vis);
    if (!f) return { ok: false, why: 'no email field' };
    f.focus();
    f.select && f.select();
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, value);
    } catch (e) {}
    if (!ok || f.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, value);
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }
    f.dispatchEvent(new Event('change', { bubbles: true }));
    const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const all = [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis);
    const b =
      all.find((x) => /continue with email/i.test(label(x))) ||
      (f.form && [...f.form.querySelectorAll('button[type=submit], input[type=submit]')].find(vis)) ||
      all.find((x) => /^continue$/i.test(label(x)));
    if (!b) return { ok: false, why: 'no email button' };
    if (b.disabled) return { ok: false, why: 'the email button is disabled' };
    b.click();
    return { ok: true };
  },

  /** Press the first visible button whose label matches (a regular expression's source, case ignored). */
  press: (source) => {
    const re = new RegExp(source, 'i');
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const b = [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis).find((x) => re.test(label(x)));
    if (!b) return { ok: false, why: 'no such button' };
    if (b.disabled) return { ok: false, why: 'the button is disabled' };
    b.click();
    return { ok: true, label: label(b).slice(0, 80) };
  },

  /** The page as structure: headings, fields (type, name, placeholder, label; never a value) and buttons. */
  survey: () => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const t = (s, n) => (s || '').trim().replace(/\s+/g, ' ').slice(0, n);
    const labelOf = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return t(l.innerText, 80);
      }
      return el.getAttribute('aria-label');
    };
    return {
      page: location.origin + location.pathname,
      title: t(document.title, 100),
      headings: [...document.querySelectorAll('h1, h2, h3')].filter(vis).map((h) => t(h.innerText, 100)).filter(Boolean).slice(0, 15),
      inputs: [...document.querySelectorAll('input, textarea, select')]
        .filter((el) => el.type !== 'hidden' && vis(el))
        .slice(0, 20)
        .map((el) => ({ type: el.type || el.tagName.toLowerCase(), name: el.getAttribute('name'), id: el.id || null, placeholder: el.getAttribute('placeholder'), label: labelOf(el) })),
      buttons: [...document.querySelectorAll('button, [role=button], input[type=submit], a[role=button]')]
        .filter(vis)
        .map((b) => t(b.innerText || b.value || b.getAttribute('aria-label'), 80))
        .filter(Boolean)
        .slice(0, 30),
      challenge: document.title === 'Just a moment...' || !!document.querySelector("iframe[src*='challenges.cloudflare.com'], .cf-turnstile"),
    };
  },
};
