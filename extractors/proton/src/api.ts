/**
 * Proton's API as the extractor sees it: a transport that makes one call (through the page's hook in the sandbox, or
 * straight to a fake in tests) and the rules around it: Proton's JSON errors (`{ Code, Error }`) become StatusErrors
 * with the HTTP status, 429 and 5xx are retried with growing waits (honouring Retry-After), and every refusal is
 * logged with the method, a path with ids taken out, the status and Proton's code and reason: never a body.
 */
import { StatusError } from '@dither-accounts/link';

export type Query = Record<string, string | number | boolean | (string | number)[] | undefined | null>;
export interface ApiRequest {
  method: string;
  /** Without /api/: `mail/v4/messages`. */
  path: string;
  query?: Query;
  body?: unknown;
  /** The answer is bytes (an attachment): base64 in `base64`. */
  binary?: boolean;
}
export interface ApiAnswer {
  status: number;
  json?: any;
  base64?: string;
  text?: string;
  retryAfter?: string | null;
  /** The hook waited for the page to refresh its session after a 401. */
  waitedForRefresh?: boolean;
}
export type Transport = (req: ApiRequest) => Promise<ApiAnswer>;
type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** Proton's codes this reads: 1000/1001 fine, 2501 not found, 2061 an id it does not know, 9001 a human check. */
export const CODES = { OK: 1000, MULTI_OK: 1001, NOT_FOUND: 2501, INVALID_ID: 2061, HUMAN_VERIFICATION: 9001, APP_VERSION_BAD: 5003 };
const RETRIES = 4;
const BACKOFF = Number(process.env.DITHER_PROTON_BACKOFF_MS) || 500;

/** A path for the log: ids (anything long, or with digits past a few characters) taken out. */
export function template(path: string): string {
  return path
    .split('/')
    .map((s) => (s.length > 16 || (/\d/.test(s) && s.length > 3 && !/^v\d+$/.test(s)) ? ':id' : s))
    .join('/');
}

export class ProtonError extends StatusError {
  constructor(
    message: string,
    status: number,
    readonly code: number | null,
  ) {
    super(message, status);
  }
}

export interface ApiStats {
  lastAt: number;
  lastStatus: number | null;
  lastOkAt: number;
  lastError: string | null;
  calls: number;
}

export class ProtonApi {
  readonly stats: ApiStats = { lastAt: 0, lastStatus: null, lastOkAt: 0, lastError: null, calls: 0 };
  /** Called after every answer, for the status. */
  onAnswer: (status: number, code: number | null) => void = () => {};

  constructor(
    private transport: Transport,
    private log: Log,
  ) {}

  /** One call; its JSON (or, for binary, `{ base64 }`). Throws ProtonError on anything but 2xx. */
  async call<T = any>(req: ApiRequest): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let r: ApiAnswer;
      try {
        r = await this.transport(req);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        this.stats.lastError = msg;
        throw e instanceof StatusError ? e : new ProtonError(msg, 503, null);
      }
      this.stats.calls++;
      this.stats.lastAt = Date.now();
      this.stats.lastStatus = r.status;
      const code: number | null = typeof r.json?.Code === 'number' ? r.json.Code : null;
      this.onAnswer(r.status, code);
      if (r.status >= 200 && r.status < 300 && (code === null || code === CODES.OK || code === CODES.MULTI_OK)) {
        this.stats.lastOkAt = Date.now();
        this.stats.lastError = null;
        return (req.binary ? { base64: r.base64 ?? '' } : (r.json ?? {})) as T;
      }
      const reason = typeof r.json?.Error === 'string' ? r.json.Error.slice(0, 200) : r.text ? `not JSON: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}` : 'no body';
      const retryable = r.status === 429 || r.status >= 500;
      this.log(retryable && attempt < RETRIES ? 'info' : 'warn', `${req.method} ${template(req.path)}: ${r.status}${code !== null ? ` code ${code}` : ''} (${reason})${r.waitedForRefresh ? ', after waiting for the page to refresh its session' : ''}`);
      if (retryable && attempt < RETRIES) {
        const after = Number(r.retryAfter);
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF * 2 ** attempt * (1 + Math.random() * 0.25);
        await Bun.sleep(Math.min(wait, 60_000));
        continue;
      }
      this.stats.lastError = `${r.status}${code !== null ? ` (code ${code})` : ''}: ${reason}`;
      throw errorFor(r.status, code, reason);
    }
  }
}

function errorFor(status: number, code: number | null, reason: string): ProtonError {
  if (status === 401) return new ProtonError('Proton signed this browser out; sign in again in the live view', 401, code);
  if (code === CODES.NOT_FOUND || code === CODES.INVALID_ID || status === 404) return new ProtonError(`not found: ${reason}`, 404, code);
  if (code === CODES.HUMAN_VERIFICATION) return new ProtonError('Proton asks for a human check before this; open the live view and do it in Proton Mail', 403, code);
  if (code === CODES.APP_VERSION_BAD) return new ProtonError(`Proton refused the web app's version: ${reason}`, 400, code);
  return new ProtonError(`Proton answered ${status}${code !== null ? ` (code ${code})` : ''}: ${reason}`, status >= 200 && status < 300 ? 502 : status, code);
}
