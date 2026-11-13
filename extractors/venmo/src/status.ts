/**
 * The venmo account's status from what the extractor knows. Pure, so it is tested (test/status.test.ts).
 *
 * Venmo ends a web session after about 30 idle minutes and nothing here keeps it alive,
 * so "signed out" is the usual state, not a fault: the account asks you to sign in only when it has never pulled, or
 * when its last pull that found you signed in is older than `nagAfterDays` (default 7). Otherwise it is online and
 * the "signed in" layer says that the next pull waits for your next sign-in.
 */

/** Paths that are about signing in, not a signed-in page. */
const SIGN_IN = /(^|\/)(login|signin|sign-in|signup|sign-up|logout|verify|auth|mfa|otp|challenge|2fa|forgot-password)(\/|$)/i;

export type PageKind = 'none' | 'signin' | 'app' | 'site' | 'other';

/** The web app (account.venmo.com) on a page that is not a sign-in page is "app"; id.venmo.com and venmo.com's sign-in pages are "signin". */
export function pageKind(url: string | null, appOrigin: string): PageKind {
  if (!url) return 'none';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  if (u.origin === appOrigin) return SIGN_IN.test(u.pathname) ? 'signin' : 'app';
  const site = new URL(appOrigin).hostname.split('.').slice(-2).join('.');
  if (u.hostname === site || u.hostname.endsWith(`.${site}`)) return u.hostname.startsWith('id.') || SIGN_IN.test(u.pathname) ? 'signin' : 'site';
  return 'other';
}

export const SIGN_IN_MESSAGE = 'Sign in to Venmo in the live view. The pull starts by itself once you are in (Venmo ends a session after about 30 idle minutes, so sign in when you want a pull).';
export const STALE_MESSAGE = (days: number) => `No Venmo pull for ${days}+ days: sign in in the live view and the pull starts by itself.`;

export interface View {
  signedIn: boolean;
  /** The last pull that found Venmo signed in (ms), or null. */
  lastSignedInPull: number | null;
  nagAfterDays: number;
  now: number;
  page: string | null;
  kind: PageKind;
}

export function state(v: View): { status: string; attention: { kind: string; message: string; liveView: boolean } | null } {
  if (v.signedIn) return { status: 'online', attention: null };
  if (v.lastSignedInPull === null) return { status: 'attention', attention: { kind: 'login', message: SIGN_IN_MESSAGE, liveView: true } };
  if (v.now - v.lastSignedInPull > v.nagAfterDays * 24 * 3600_000) return { status: 'attention', attention: { kind: 'login', message: STALE_MESSAGE(v.nagAfterDays), liveView: true } };
  return { status: 'online', attention: null };
}

export function signedInLayer(v: View): { name: string; state: 'ok' | 'waiting'; note: string } {
  const path = (() => {
    try {
      return v.page ? new URL(v.page).pathname : null;
    } catch {
      return null;
    }
  })();
  if (v.signedIn) return { name: 'signed in', state: 'ok', note: `on ${path ?? 'the app'}` };
  if (v.kind === 'app') return { name: 'signed in', state: 'waiting', note: 'the app is loading' };
  return {
    name: 'signed in',
    state: 'waiting',
    note: v.lastSignedInPull
      ? `signed out (Venmo ends a session after ~30 idle minutes); the next pull follows your next sign-in in the live view`
      : 'sign in in the live view; the pull follows by itself',
  };
}
