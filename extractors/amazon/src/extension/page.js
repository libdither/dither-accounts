/*
 * The Amazon kind's page functions, run by sw.js with chrome.scripting in the extractor's own tab (the extension's
 * isolated world: the page's scripts never see them). Each is self-contained (it is serialized into the page) and
 * reads what connectors/amazon.py read through Playwright: innerText (Playwright's inner_text), attributes, and
 * whether an element is visible (Playwright's :visible: a non-empty box and no visibility:hidden). The extractor
 * (src/amazon.ts) does all the parsing.
 */
self.PAGE = {
  /** A Your Orders page: the time filter's values, each order card's text and product links, and the next page's link. */
  orderList: (n) => {
    const cards = [...document.querySelectorAll('.order-card, .js-order-card')].map((c) => ({
      text: c.innerText,
      links: [...c.querySelectorAll("a[href*='/dp/']")].map((a) => ({ href: a.getAttribute('href'), text: a.innerText })),
    }));
    const years = [...document.querySelectorAll('select[name=timeFilter] option')].map((o) => o.getAttribute('value'));
    return { years, cards, next: !!document.querySelector(`a[href*='page=${n + 1}']`) };
  },

  /** An order's details page: ship-to block, items, the charge summary, and the page's text (for the card). */
  orderDetails: () => {
    const q = (s) => document.querySelector(s);
    const sa = q('[data-component=shippingAddress]');
    const items = [...document.querySelectorAll('[data-component=purchasedItems]')].map((it) => {
      const g = (s) => it.querySelector(s);
      const title = g('[data-component=itemTitle]');
      const link = g("a[href*='/dp/']");
      const price = g('[data-component=unitPrice]');
      const qty = g('[data-component=quantity]');
      const seller = g('[data-component=orderedMerchant]');
      return {
        title: title ? title.innerText : null,
        href: link ? link.getAttribute('href') : null,
        hasLink: !!link,
        price: price ? price.innerText : null,
        qty: qty ? qty.innerText : null,
        seller: seller ? seller.innerText : null,
      };
    });
    const cs = q('[data-component=chargeSummary]');
    return { ship: sa ? sa.innerText : null, items, charge: cs ? cs.innerText : null, body: document.body ? document.body.innerText : '' };
  },

  /**
   * Where the tab is and whether Amazon is asking for something only you can give: a captcha (on a sign-in page or
   * Amazon's robot check), its "I am human" checkpoint; and whether the header says you are signed in.
   */
  probe: () => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const first = (sel) => [...document.querySelectorAll(sel)].find(vis) || null;
    // Playwright's get_by_text: the page's text (not scripts or styles), case and spacing ignored.
    const text = (() => {
      const out = [];
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentElement;
        if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        out.push(n.nodeValue);
      }
      return out.join(' ').replace(/\s+/g, ' ').toLowerCase();
    })();
    const email = first('input#ap_email, input[name=email]');
    const nav = document.querySelector('#nav-link-accountList-nav-line-1');
    const navText = nav ? nav.innerText.trim().toLowerCase() : null;
    return {
      url: location.href,
      ready: document.readyState,
      captcha: !!document.querySelector("#auth-captcha-image, #captchacharacters, iframe[src*='captcha']"),
      robot: !!document.querySelector("form[action*='validateCaptcha']"),
      human: text.includes('i am human'),
      email: email ? { empty: !email.value } : null,
      password: !!first('input#ap_password'),
      otp: !!first('input#auth-mfa-otpcode'),
      cvf: location.pathname.includes('/ap/cvf') || !!document.querySelector('#cvf-page-content, [name=cvf_captcha_input]'),
      continueButton: !!(document.querySelector('input#continue') || document.querySelector('#continue')),
      signedIn: navText === null ? null : !navText.includes('sign in'),
    };
  },

  /**
   * One sign-in step, as amazon_auth.py did it: type the value into the visible field (as typing does: the editor's
   * insertText, so the page sees input events), tick "keep me signed in" / "don't ask on this browser", press the
   * step's button. The value comes from the extractor for this step only and is not kept.
   */
  signInStep: (step, value) => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const first = (sel) => [...document.querySelectorAll(sel)].find(vis) || null;
    const fill = (el) => {
      el.focus();
      el.select && el.select();
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, value);
      } catch (e) {}
      if (!ok || el.value !== value) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const tick = (el) => {
      if (el && !el.checked) el.click();
    };
    if (step === 'email') {
      const f = first('input#ap_email, input[name=email]');
      if (!f) return { ok: false, why: 'no email field' };
      fill(f);
      const b = document.querySelector('input#continue') || document.querySelector('#continue');
      if (!b) return { ok: false, why: 'no continue button' };
      b.click();
      return { ok: true };
    }
    if (step === 'password') {
      const f = first('input#ap_password');
      if (!f) return { ok: false, why: 'no password field' };
      fill(f);
      tick(document.querySelector('input[name=rememberMe]'));
      const b = document.querySelector('#signInSubmit');
      if (!b) return { ok: false, why: 'no sign-in button' };
      b.click();
      return { ok: true };
    }
    if (step === 'otp') {
      const f = first('input#auth-mfa-otpcode');
      if (!f) return { ok: false, why: 'no code field' };
      fill(f);
      tick(document.querySelector('input#auth-mfa-remember-device'));
      const b = document.querySelector('#auth-signin-button');
      if (!b) return { ok: false, why: 'no code button' };
      b.click();
      return { ok: true };
    }
    return { ok: false, why: 'unknown step' };
  },
};
