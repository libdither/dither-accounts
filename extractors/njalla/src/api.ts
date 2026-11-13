/**
 * Njalla's API: JSON-RPC over one POST to https://njal.la/api/1/, `Authorization: Njalla <token>`, a body of
 * `{ method, params }`, and an answer of `{ result }` or `{ error: { code, message } }` (go-acme/lego's njalla client
 * speaks the same). Record ids come back as strings.
 *
 * Only the record methods below are ever sent. Njalla's `add-token` ignores parameters it does not know and then
 * makes an unrestricted token, and the account methods move money or domains: none of them can go out from here.
 */
import { StatusError } from '@dither-accounts/link';

export const API_URL = 'https://njal.la/api/1/';

const METHODS = ['list-domains', 'list-records', 'add-record', 'edit-record', 'remove-record'] as const;
export type Method = (typeof METHODS)[number];

export type Failure =
  /** The token is not (or no longer) good, or may not do this. */
  | 'auth'
  /** Njalla refused the request itself: a bad record, an unknown domain. */
  | 'refused'
  | 'rate'
  /** No HTTP answer at all: DNS, refused, timed out. */
  | 'network'
  | 'http';

export class NjallaError extends StatusError {
  constructor(
    message: string,
    status: number,
    readonly failure: Failure,
  ) {
    super(message, status);
  }
}

export interface RawRecord {
  id: string | number;
  name: string;
  type: string;
  content: string;
  ttl?: number | null;
  prio?: number | null;
  [k: string]: unknown;
}

export interface RawDomain {
  name: string;
  status?: string | null;
  expiry?: string | null;
}

/** Words in Njalla's error messages that mean the token, not the request. */
const AUTH_WORDS = /permission|unauthori[sz]ed|forbidden|token|not logged in|authenticat/i;

export async function rpc<T>(token: string, method: Method, params: Record<string, unknown>, url = API_URL, timeoutMs = 20_000): Promise<T> {
  if (!METHODS.includes(method)) throw new NjallaError(`njalla: "${method}" is not a method this kind sends`, 400, 'refused');
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Njalla ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    throw new NjallaError(`njalla did not answer (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message})`, 503, 'network');
  }
  if (r.status === 401 || r.status === 403) throw new NjallaError(`njalla turned the token away (HTTP ${r.status})`, 401, 'auth');
  if (r.status === 429) throw new NjallaError('njalla asks to slow down (HTTP 429)', 429, 'rate');
  if (!r.ok) throw new NjallaError(`njalla answered HTTP ${r.status}`, 502, 'http');
  let j: { result?: T; error?: { code?: number; message?: string } | null };
  try {
    j = (await r.json()) as typeof j;
  } catch {
    throw new NjallaError('njalla answered something that is not JSON', 502, 'http');
  }
  if (j.error) {
    const code = Number(j.error.code) || 0;
    const message = String(j.error.message ?? 'no message');
    // A scoped token may be refused one domain and not another: the caller checks the token again before it calls the
    // whole account signed out.
    if (code === 401 || code === 403 || AUTH_WORDS.test(message)) throw new NjallaError(`njalla: ${message}`, 403, 'auth');
    throw new NjallaError(`njalla: ${message}`, code >= 400 && code < 500 ? code : 400, 'refused');
  }
  return (j.result ?? ({} as T)) as T;
}
