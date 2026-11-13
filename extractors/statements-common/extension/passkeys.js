
/*
 * Appended to driver.js in the copy of a kind's extension that has a passkey (schwab: statements-common/src/tabs.ts
 * `passkeys`). The kind's hook.js and content.js (content scripts on the site's frames) open ports to this worker; a
 * passkey request from a page goes up with where it came from as Chromium reports it, and the extractor's answer,
 * the command `webauthn.answer`, goes back to that frame only (packages/browser/src/page/webauthn-worker.js, put in
 * below when the extension is copied). The hooks' other words (that a page is up) go up as they are.
 */
/*@include webauthn-worker@*/
EXTRA['webauthn.answer'] = (cmd) => passkeys.answer(cmd);
// WebAuthn's related origin requests: the relying party's list of the origins that may use its rpId, fetched as
// Chromium fetches it (no cookies, no referrer). Only for an https host the extension may reach (the kind's own domains).
EXTRA['webauthn.related'] = async (cmd) => {
  const host = String((cmd && cmd.rpId) || '');
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('bad rpId');
  const r = await fetch(`https://${host}/.well-known/webauthn`, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' });
  if (!r.ok) return { status: r.status, origins: [] };
  const j = await r.json();
  const origins = Array.isArray(j && j.origins) ? j.origins.filter((o) => typeof o === 'string').slice(0, 100) : [];
  return { status: r.status, origins };
};
chrome.runtime.onConnect.addListener((port) => {
  passkeys.connect(port, (payload) => {
    if (payload.t === 'hook' || payload.t === 'log') sendUp(payload);
  });
  connect();
});
