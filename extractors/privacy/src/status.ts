/**
 * The privacy account's status from what the extractor knows: which page the sandbox's tab is on, whether the
 * extension is attached, and the passkey's non-secret facts. Pure, so the steps it walks you through are tested
 * (test/status.test.ts):
 *
 *   1. sign in to Privacy in the live view (as on your desktop)
 *   2. add a passkey in Privacy's settings: this browser answers the prompt itself
 *   3. sign out and back in with that passkey, so it is known to work
 *
 * after which every layer is ok. Signed in is told from the page: the app (app.privacy.com) on a page that is not a
 * sign-in page, for SETTLE_MS (the app shows its home briefly before an expired session goes to /login).
 *
 * Once the passkey is checked, Privacy's short sessions are not your problem: the account signs itself in with the
 * passkey before each pull, so signed out is still online. It asks for you only when that
 * sign-in fails a few times, or when Privacy asks for something only you can give (a code, a captcha, a password):
 * then it holds every pull until the live view shows Privacy signed in again. A paired phone that refused the sign-in
 * (packages/passkey signin.ts) is the attention `approval`, saying what asks it again.
 */
import { type PasskeySummary, refusalMessage, refusalNote, type StandingRefusal } from '@dither-accounts/passkey';

export const SETTLE_MS = 6000;
/** Paths of the app that are about signing in, not a signed-in page. */
const SIGN_IN = /^\/(login|signin|sign-in|signup|sign-up|register|forgot|forgot-password|reset|reset-password|verify|two-factor|2fa|mfa|otp|auth|logout|oauth|sso)(\/|$)/i;

export type PageKind = 'none' | 'signin' | 'app' | 'site' | 'other';

/** What the tab's page is: Privacy's sign-in pages, the app signed in, privacy.com's other pages, or elsewhere. */
export function pageKind(url: string | null, appOrigin: string): PageKind {
  if (!url) return 'none';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  if (u.origin === appOrigin) return SIGN_IN.test(u.pathname) ? 'signin' : 'app';
  const appHost = new URL(appOrigin).hostname;
  const site = appHost.split('.').slice(-2).join('.');
  if (u.hostname === site || u.hostname.endsWith(`.${site}`)) return SIGN_IN.test(u.pathname) ? 'signin' : 'site';
  return 'other';
}

export type Attention = { kind: string; message: string; liveView: boolean };
export type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

export interface View {
  sandboxError: string | null;
  display: number | null;
  /** The sandbox is up and its live view listens. */
  liveView: boolean;
  browserAlive: boolean;
  attached: boolean;
  /** The extension should have attached by now. */
  attachOverdue: boolean;
  page: string | null;
  kind: PageKind;
  signedIn: boolean;
  passkey: PasskeySummary;
  /** The last request the authenticator refused, why (no secrets). */
  lastRefusal: string | null;
  /** Signing in by itself with the passkey (absent: as before the pull existed, e.g. in older tests). */
  auto?: AutoSignIn;
}

export interface AutoSignIn {
  /** A sign-in is running now. */
  signingIn: boolean;
  /** Privacy asked for something only you can give: every pull waits until it is signed in again. */
  hold: { what: string; message: string; since: number } | null;
  /** The last automatic sign-in gave up after its tries (cleared once signed in). */
  failed: string | null;
  /** The last automatic sign-in that went through. */
  lastOkAt: number | null;
  /** The paired phone refused: no automatic sign-in until a pull you start (or, if it expired, the next scheduled pull). */
  approval?: StandingRefusal | null;
}

/** What hook.js's page.state tells about a page (booleans and the path only). */
export interface PageState {
  path: string;
  passkeyButton: boolean;
  passwordInput: boolean;
  codeInput: boolean;
  captcha: boolean;
  txnSeen?: boolean;
}

/** The plain sign-in page, where the passkey button is (anything else under /login, like /login/tfa, is a step). */
const PLAIN_SIGN_IN = /^\/(login|signin|sign-in)\/?$/i;
export const CODE_MESSAGE = 'Privacy asks for the code it sent you: enter it in the live view (pulls wait until Privacy is signed in again; the passkey is not used for this).';
export const CAPTCHA_MESSAGE = 'Privacy shows a captcha: solve it in the live view and sign in there (pulls wait until Privacy is signed in again).';
export const stepMessage = (path: string) => `Privacy asks for another step (${path}): finish signing in in the live view (pulls wait until Privacy is signed in again).`;
export const autoFailedMessage = (why: string) => `Signing in to Privacy with the passkey did not work (${why}): open the live view and sign in, choosing the passkey option.`;

/**
 * Whether a sign-in page is asking for something only you can give. `afterPasskey`: the passkey has answered, so a
 * code field on the page is Privacy asking for more (before it, the sign-in form's own fields are normal). A page of
 * the app itself (its home, which it loads right after the passkey answers) asks nothing: it is the sign-in landing.
 */
export function challengeOf(p: PageState, afterPasskey: boolean): { what: string; message: string } | null {
  if (p.captcha) return { what: 'captcha', message: CAPTCHA_MESSAGE };
  if (!PLAIN_SIGN_IN.test(p.path)) {
    if (/tfa|2fa|two-factor|mfa|otp|verify|code|confirm/i.test(p.path)) return { what: 'code', message: CODE_MESSAGE };
    if (!SIGN_IN.test(p.path)) return null;
    return { what: 'step', message: stepMessage(p.path) };
  }
  if (afterPasskey && p.codeInput) return { what: 'code', message: CODE_MESSAGE };
  return null;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const minute = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const path = (u: string | null) => {
  try {
    return u ? new URL(u).pathname : null;
  } catch {
    return null;
  }
};
const host = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};

export const SIGN_IN_MESSAGE = 'Sign in to Privacy in the live view, as on your desktop (password and the code Privacy sends you). Next you add a passkey for this browser.';
export const ADD_PASSKEY_MESSAGE =
  "Signed in. Now add a passkey for this browser: in Privacy open Account → Settings → Security and add a passkey. This browser answers the passkey prompt itself (no phone, no QR code, no security key).";
export const CHECK_MESSAGE = 'Passkey added. Check that it works: sign out of Privacy in the live view, then sign in again and choose the passkey option.';
export const CHECK_SIGNED_OUT_MESSAGE = 'Passkey added. Check that it works: sign in to Privacy in the live view and choose the passkey option.';
export const SIGNED_OUT_MESSAGE = 'Privacy is signed out in the sandbox: open the live view and sign in with the passkey (choose the passkey option).';
/** The signed-in layer's note while signed out with a working passkey. */
export const SIGNS_ITSELF_IN = 'signed out for now: the passkey signs in by itself before each pull';

export function state(v: View): { status: string; attention: Attention | null } {
  const att = (a: Attention) => ({ status: 'attention', attention: a });
  if (v.sandboxError) return { status: 'error', attention: { kind: 'unknown', message: `The sandbox failed to start: ${v.sandboxError}`, liveView: false } };
  if (!v.liveView) return { status: 'connecting', attention: null };
  if (!v.attached) {
    if (v.attachOverdue) return att({ kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser', liveView: true });
    return { status: 'connecting', attention: null };
  }
  const p = v.passkey;
  const checked = !!p.newest?.verifiedAt;
  if (v.signedIn) {
    if (!p.enrolled) return att({ kind: 'passkey', message: ADD_PASSKEY_MESSAGE, liveView: true });
    if (!checked) return att({ kind: 'passkey_check', message: CHECK_MESSAGE, liveView: true });
    return { status: 'online', attention: null };
  }
  if (checked && v.auto) {
    // Signs itself in: signed out is fine, until Privacy wants you or the passkey sign-in keeps failing.
    if (v.auto.hold) return att({ kind: 'login', message: v.auto.hold.message, liveView: true });
    if (v.auto.approval) return att({ kind: 'approval', message: refusalMessage('Privacy', v.auto.approval), liveView: true });
    if (v.auto.failed) return att({ kind: 'login', message: autoFailedMessage(v.auto.failed), liveView: true });
    return { status: 'online', attention: null };
  }
  // On the app, not settled yet: give it its few seconds before asking for anything.
  if (v.kind === 'app' || v.kind === 'none') return { status: 'connecting', attention: null };
  if (!p.enrolled) return att({ kind: 'login', message: SIGN_IN_MESSAGE, liveView: true });
  if (!checked) return att({ kind: 'passkey_check', message: CHECK_SIGNED_OUT_MESSAGE, liveView: true });
  return att({ kind: 'login', message: SIGNED_OUT_MESSAGE, liveView: true });
}

/** display → browser → extension → signed in → passkey → passkey sign-in. */
export function layers(v: View): Layer[] {
  const p = v.passkey;
  const display: Layer =
    v.liveView
      ? { name: 'display', state: 'ok', note: `Xvfb :${v.display}, live view ready` }
      : v.sandboxError
        ? { name: 'display', state: 'failed', note: v.sandboxError }
        : { name: 'display', state: 'waiting', note: 'starting Xvfb' };
  const browser: Layer =
    !v.liveView
      ? { name: 'browser', state: v.sandboxError ? 'off' : 'waiting', note: 'not started yet' }
      : v.browserAlive
        ? { name: 'browser', state: 'ok', note: v.page ? `Chromium, on ${host(v.page) ?? v.page}` : 'Chromium is running' }
        : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' };
  const extension: Layer = v.attached
    ? { name: 'extension', state: 'ok', note: 'attached; it answers passkey requests on privacy.com only' }
    : v.attachOverdue
      ? { name: 'extension', state: 'failed', note: 'did not attach' }
      : { name: 'extension', state: 'waiting', note: 'not attached yet' };
  const a = v.auto;
  const auto = !!a && !!p.newest?.verifiedAt;
  const signedIn: Layer = v.signedIn
    ? { name: 'signed in', state: 'ok', note: `on ${path(v.page) ?? 'the app'}` }
    : auto && a!.hold
      ? { name: 'signed in', state: 'failed', note: `held: Privacy asks for ${a!.hold.what === 'code' ? 'a code' : a!.hold.what === 'captcha' ? 'a captcha' : 'another step'}; sign in in the live view` }
      : auto && a!.approval
        ? { name: 'signed in', state: 'failed', note: `the passkey sign-in stopped: ${refusalNote(a!.approval)}` }
      : auto && a!.failed
        ? { name: 'signed in', state: 'failed', note: `the passkey sign-in failed: ${a!.failed}` }
        : auto && v.attached
          ? { name: 'signed in', state: a!.signingIn ? 'waiting' : 'ok', note: a!.signingIn ? 'signing in with the passkey' : SIGNS_ITSELF_IN }
          : !v.attached
      ? { name: 'signed in', state: 'waiting', note: 'waits for the extension' }
      : v.kind === 'app'
        ? { name: 'signed in', state: 'waiting', note: 'the app is loading' }
        : v.kind === 'other'
          ? { name: 'signed in', state: 'waiting', note: `the tab is on ${host(v.page) ?? v.page}, not Privacy` }
          : { name: 'signed in', state: 'waiting', note: 'sign in to Privacy in the live view' };
  const n = p.newest;
  const passkey: Layer = n
    ? { name: 'passkey', state: 'ok', note: `${n.algorithm} passkey ${n.idPrefix}… for ${n.rpId}, added ${day(n.createdAt)}${p.count > 1 ? ` (${p.count} held)` : ''}` }
    : { name: 'passkey', state: 'waiting', note: v.lastRefusal ? `none yet; last request refused: ${v.lastRefusal}` : "none yet: add one in Privacy's Security settings once signed in" };
  const check: Layer = n?.verifiedAt
    ? { name: 'passkey sign-in', state: 'ok', note: `signed in with it ${minute(n.verifiedAt)}${n.lastUsedAt ? `; last used ${minute(n.lastUsedAt)}` : ''}` }
    : n
      ? { name: 'passkey sign-in', state: 'waiting', note: n.lastUsedAt ? `used ${minute(n.lastUsedAt)}, but no sign-in with it was seen to finish yet` : 'sign out and back in with the passkey to check it' }
      : { name: 'passkey sign-in', state: 'waiting', note: 'waits for a passkey' };
  return [display, browser, extension, signedIn, passkey, check];
}

/** Names, ids and counts only. */
export function details(v: View, counts: { creations: number; assertions: number; refusals: number }): Record<string, string | number | boolean | null> {
  const n = v.passkey.newest;
  return {
    display: v.display !== null && v.liveView ? `:${v.display}` : null,
    page: v.page,
    pageKind: v.kind,
    extensionAttached: v.attached,
    signedIn: v.signedIn,
    passkeyEnrolled: v.passkey.enrolled,
    passkeys: v.passkey.count,
    credentialIdPrefix: n ? `${n.idPrefix}…` : null,
    passkeyAlgorithm: n?.algorithm ?? null,
    passkeyRpId: n?.rpId ?? null,
    passkeyCreated: n ? day(n.createdAt) : null,
    passkeyLastUsed: n?.lastUsedAt ? minute(n.lastUsedAt) : null,
    passkeySignInChecked: n?.verifiedAt ? minute(n.verifiedAt) : null,
    passkeysMadeThisRun: counts.creations,
    signInsThisRun: counts.assertions,
    refusedThisRun: counts.refusals,
    lastRefusal: v.lastRefusal,
    autoSignIn: !v.auto
      ? null
      : v.auto.hold
        ? `held (${v.auto.hold.what}) since ${minute(v.auto.hold.since)}`
        : v.auto.approval
          ? `stopped: ${v.auto.approval.reason} on ${v.auto.approval.device} at ${minute(v.auto.approval.at)}`
        : v.auto.failed
          ? `failed: ${v.auto.failed}`
          : v.auto.signingIn
            ? 'signing in'
            : n?.verifiedAt
              ? 'ready'
              : 'waits for a checked passkey',
    lastAutoSignIn: v.auto?.lastOkAt ? minute(v.auto.lastOkAt) : null,
  };
}

/** Why a pull cannot start now, or null (signed out is fine: the pull signs in with the passkey first). */
export function statementsBlocked(v: { attached: boolean; passkey: PasskeySummary; hold: AutoSignIn['hold'] }): string | null {
  if (!v.attached) return 'the sandbox browser is not up yet';
  if (!v.passkey.enrolled) return 'no passkey yet: sign in in the live view and add one in Privacy (Account → Settings → Security)';
  if (!v.passkey.newest?.verifiedAt) return 'the passkey is not checked yet: sign out and back in with it in the live view';
  if (v.hold) return `Privacy is waiting for you in the live view: ${v.hold.message}`;
  return null;
}
