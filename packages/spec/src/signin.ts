/**
 * Signing in with an account you already have here (docs/signin-relay.md): the sign-in providers a browser account
 * can answer for another one, and how their sign-in links are read. Pure data and parsing, shared by the manager (which
 * checks each relay), the browser package (which tells a sandbox's extension what to look for) and the provider kinds.
 *
 * A provider here is one whose "Continue with X" button is a plain redirect flow: the site sends the browser to the
 * provider's authorize page with its `redirect_uri`, and the provider sends it back to that address with a one-time
 * `code` (and the site's `state`) in the query. That covers Google's redirect flow, which is what most sites' Google
 * buttons use. Flows that answer by a form post or by window messages are not relayed.
 */

export interface SignInProvider {
  /** The id kinds name in their manifest's `signsIn`: `google`. */
  id: string;
  /** For the chooser and the logs: `Google`. */
  name: string;
  /** Hosts its authorize page is on (https only). */
  hosts: string[];
  /** Paths there that are an authorize page (a prefix match). */
  paths: string[];
}

export const SIGN_IN_PROVIDERS: Record<string, SignInProvider> = {
  google: { id: 'google', name: 'Google', hosts: ['accounts.google.com'], paths: ['/o/oauth2/v2/auth', '/o/oauth2/auth', '/signin/oauth'] },
};

/** A sign-in link, read: who it asks, where the answer goes, and what it asks for. */
export interface Authorize {
  provider: string;
  /** The `redirect_uri`, its origin and path only (no query): the address the answer must come back to. */
  redirect: string;
  /** The site the sign-in is for: the redirect's origin. */
  site: string;
  /** The `scope` words, as the link has them. */
  scopes: string[];
}

/**
 * The provider whose authorize page `url` is, or null. `testOrigins` maps a provider to the origin that stands for it in
 * tests (http on loopback allowed there only).
 */
export function providerOf(url: string, testOrigins: Record<string, string> = {}): SignInProvider | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const p of Object.values(SIGN_IN_PROVIDERS)) {
    const test = testOrigins[p.id];
    const onHost = (u.protocol === 'https:' && p.hosts.includes(u.host)) || (!!test && u.origin === test);
    if (onHost && p.paths.some((x) => u.pathname === x || u.pathname.startsWith(`${x}/`))) return p;
  }
  return null;
}

/**
 * `url` read as a redirect-flow sign-in link, or why it is not one. The answer must come back by redirect with a code:
 * `response_type` has `code` and no `response_mode` other than `query`; `redirect_uri` is an absolute https address
 * (loopback http too, for tests, when `allowLoopback`).
 */
export function readAuthorize(url: string, o: { testOrigins?: Record<string, string>; allowLoopback?: boolean } = {}): Authorize | { error: string } {
  const p = providerOf(url, o.testOrigins);
  if (!p) return { error: "not a sign-in provider's authorize page" };
  const q = new URL(url).searchParams;
  const types = (q.get('response_type') ?? '').split(/\s+/).filter(Boolean);
  if (!types.includes('code')) return { error: 'only sign-ins that answer with a code are relayed' };
  const mode = q.get('response_mode');
  if (mode && mode !== 'query') return { error: `the answer would come back by ${mode}, not in the address` };
  const raw = q.get('redirect_uri');
  if (!raw) return { error: 'the link names no redirect_uri' };
  let r: URL;
  try {
    r = new URL(raw);
  } catch {
    return { error: 'its redirect_uri is not an address' };
  }
  const loopback = r.protocol === 'http:' && (r.hostname === '127.0.0.1' || r.hostname === 'localhost');
  if (r.protocol !== 'https:' && !(o.allowLoopback && loopback)) return { error: 'its redirect_uri is not https' };
  if (r.username || r.password) return { error: 'its redirect_uri carries a user name' };
  return { provider: p.id, redirect: r.origin + r.pathname, site: r.origin, scopes: (q.get('scope') ?? '').split(/\s+/).filter(Boolean) };
}

/** Whether `answer` is the provider's answer for `redirect`: that address, with a query (and nothing on another path). */
export function isAnswer(answer: string, redirect: string): boolean {
  let a: URL;
  try {
    a = new URL(answer);
  } catch {
    return false;
  }
  return a.origin + a.pathname === redirect && (a.searchParams.has('code') || a.searchParams.has('error'));
}

const GOOGLE_SCOPES: Record<string, string> = {
  openid: 'who you are',
  email: 'your email address',
  profile: 'your name and picture',
  'https://www.googleapis.com/auth/userinfo.email': 'your email address',
  'https://www.googleapis.com/auth/userinfo.profile': 'your name and picture',
  'https://www.googleapis.com/auth/contacts.readonly': 'your contacts (read)',
  'https://www.googleapis.com/auth/contacts': 'your contacts',
  'https://www.googleapis.com/auth/calendar': 'your calendars',
  'https://www.googleapis.com/auth/calendar.readonly': 'your calendars (read)',
  'https://www.googleapis.com/auth/calendar.events': 'your calendar events',
  'https://mail.google.com/': 'all your Gmail',
  'https://www.googleapis.com/auth/gmail.readonly': 'your Gmail (read)',
  'https://www.googleapis.com/auth/drive': 'all of your Drive',
  'https://www.googleapis.com/auth/drive.readonly': 'your Drive (read)',
  'https://www.googleapis.com/auth/drive.file': 'Drive files you open with it',
};

/** What a link's scopes ask for, in words, each once: the chooser shows them. Unknown ones by their last part. */
export function scopeWords(provider: string, scopes: string[]): string[] {
  const out: string[] = [];
  for (const s of scopes) {
    const w = (provider === 'google' ? GOOGLE_SCOPES[s] : undefined) ?? s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '').slice(0, 80);
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Only who you are: the usual "sign in with" scopes, nothing of your data. */
export function onlyIdentity(provider: string, scopes: string[]): boolean {
  const id = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
  return provider === 'google' && scopes.every((s) => id.includes(s));
}
