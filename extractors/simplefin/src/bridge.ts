/**
 * SimpleFIN Bridge's protocol, as dither-finance's simplefin/sfin.py speaks it (stdlib Python, ported line for line
 * where the bytes or the requests depend on it): the setup-token claim, `GET <access>/accounts?version=2&…` with the
 * access URL's credentials as Basic auth, and the 45-day windows with a 5-day overlap.
 */
import { NeedsYou } from '@dither-accounts/statements-common';

/** The bridge warns above 45 days per request. */
export const WINDOW = 45 * 86400;

/** sfin.py pull(): [start, end] in seconds, newest first. `now` is int(time.time()). */
export function windows(now: number, days: number): [number, number][] {
  const out: [number, number][] = [];
  const floor = now - days * 86400;
  let end = now + 86400;
  while (end > floor) {
    const start = Math.max(end - WINDOW, floor);
    out.push([start, end]);
    end = start > floor ? start + 5 * 86400 : start;
  }
  return out;
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** time.strftime("%Y%m%dT%H%M%S"), local time. */
export const stamp = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

/** The access URL as sfin.py's get() splits it: credentials out (as a Basic header), the rest + "/accounts". */
export function accessParts(accessUrl: string): { url: string; auth: string; host: string } {
  const u = new URL(accessUrl.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new NeedsYou('the access URL is not an https URL', 'config');
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/accounts`;
  return { url, auth, host: u.hostname };
}

/** urllib.parse.urlencode for the plain values sfin.py sends. */
export const urlencode = (params: [string, string | number][]) => params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

export interface BridgeOpts {
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}
const UA = 'dither-accounts/0.1';

/** GET /accounts; the response's text. 402 and 403 are yours to fix (sfin.py's messages). */
export async function getAccounts(accessUrl: string, params: [string, string | number][], o: BridgeOpts = {}): Promise<string> {
  const { url, auth } = accessParts(accessUrl);
  const r = await (o.fetch ?? fetch)(`${url}?${urlencode([['version', 2], ...params])}`, {
    headers: { authorization: auth, 'user-agent': o.userAgent ?? UA, accept: 'application/json' },
    signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    redirect: 'error',
  });
  if (r.status === 402) throw new NeedsYou('HTTP 402: SimpleFIN subscription payment required', 'payment');
  if (r.status === 403) throw new NeedsYou('HTTP 403: access revoked or bad credentials; add the account again with a new setup token', 'login');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

/** sfin.py claim(): the setup token is a base64 claim URL; POST to it once for the access URL. */
export async function claim(token: string, o: BridgeOpts = {}): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(token.trim(), 'base64').toString('utf8');
  } catch {
    throw new NeedsYou('the setup token is not base64', 'config');
  }
  if (!claimUrl.startsWith('https://') && !(o.fetch && claimUrl.startsWith('http://'))) throw new NeedsYou('the setup token does not decode to an https URL', 'config');
  const r = await (o.fetch ?? fetch)(claimUrl, { method: 'POST', body: '', headers: { 'content-length': '0', 'user-agent': o.userAgent ?? UA }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (r.status === 403) throw new NeedsYou('claim failed: HTTP 403 (already claimed or invalid; if you did not claim it, revoke it at bridge.simplefin.org)', 'login');
  if (!r.ok) throw new Error(`claim failed: HTTP ${r.status}`);
  const access = (await r.text()).trim();
  if (!/^https?:\/\//.test(access)) throw new Error('the claim did not answer an access URL');
  return access;
}
