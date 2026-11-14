/**
 * The claude kind's checks and status, kept pure so they are tested (test/flow.test.ts). The extractor (main.ts) only
 * opens claude.ai pages it was given after these say they are claude.ai's own: the emailed sign-in link and an OAuth
 * authorize URL whose redirect goes back to this machine.
 */

/** The emailed sign-in link: https://claude.ai/magic-link#<token> (the token is in the fragment). */
export function magicLinkOk(link: string, base: string): boolean {
  try {
    const u = new URL(link);
    return u.origin === base && u.pathname === '/magic-link' && u.hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * An OAuth authorize URL CLIProxyAPI made (https://claude.ai/oauth/authorize?…&redirect_uri=http://localhost:54545/callback):
 * the redirect it names, or why it is refused. Only a redirect to this machine over plain http is taken, so the code
 * never leaves it.
 */
export function authorizeTarget(url: string, base: string): { redirect: string } | { why: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { why: 'not a URL' };
  }
  if (u.origin !== base) return { why: `not ${base}` };
  if (u.pathname !== '/oauth/authorize') return { why: 'not the OAuth authorize page' };
  if (u.searchParams.get('response_type') !== 'code') return { why: 'not a code request' };
  const r = u.searchParams.get('redirect_uri');
  if (!r) return { why: 'no redirect_uri' };
  let ru: URL;
  try {
    ru = new URL(r);
  } catch {
    return { why: 'redirect_uri is not a URL' };
  }
  if (ru.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(ru.hostname)) return { why: 'redirect_uri does not go back to this machine' };
  if (!u.searchParams.get('state') || !u.searchParams.get('code_challenge')) return { why: 'no state or PKCE challenge' };
  return { redirect: `${ru.origin}${ru.pathname}` };
}

/** The tab has reached the redirect with a code (or an error) for this request. */
export function isCallback(tabUrl: string, redirect: string): boolean {
  if (!tabUrl.startsWith(`${redirect}?`)) return false;
  try {
    const q = new URL(tabUrl).searchParams;
    return q.has('code') || q.has('error');
  } catch {
    return false;
  }
}

export const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface View {
  signedIn: boolean | null;
  email: string | null;
  expectedEmail: string | null;
  /** A step stopped at something only you can answer (a human check). */
  hold: { message: string; since: number } | null;
}

export function state(v: View): { status: string; attention: { kind: string; message: string; liveView: boolean } | null } {
  if (v.hold) return { status: 'attention', attention: { kind: 'login', message: v.hold.message, liveView: true } };
  if (v.signedIn && v.expectedEmail && v.email && !sameEmail(v.email, v.expectedEmail))
    return { status: 'attention', attention: { kind: 'login', message: `claude.ai is signed in as another account; sign out in the live view (this account is for ${v.expectedEmail})`, liveView: true } };
  return { status: 'online', attention: null };
}

export function signedInLayer(v: View): { name: string; state: 'ok' | 'waiting' | 'failed'; note: string } {
  if (v.hold) return { name: 'signed in', state: 'failed', note: 'held: a check only you can answer (open the live view)' };
  if (v.signedIn === true) {
    if (v.expectedEmail && v.email && !sameEmail(v.email, v.expectedEmail)) return { name: 'signed in', state: 'failed', note: 'as another account' };
    return { name: 'signed in', state: 'ok', note: v.email ? `as ${v.email}` : 'yes' };
  }
  if (v.signedIn === false) return { name: 'signed in', state: 'waiting', note: 'signed out: the cliproxy provider signs in with an emailed link' };
  return { name: 'signed in', state: 'waiting', note: 'not seen yet' };
}

/** Claude's human check, as the extension reads it, in words for the live view. */
export const NEEDS_YOU = 'claude.ai is showing a check only you can answer: open the live view and answer it, then try again';
