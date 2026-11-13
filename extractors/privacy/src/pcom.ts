/**
 * What dither-finance's privacy/pcom.py `pull` decided and wrote, as pure functions (docs/privacy.md): the requests it
 * made from the app's own transactions request (its query, Python's parse_qsl/urlencode), the paging (offset paging,
 * repeated until every row the server counts was seen, at most four passes), the KEEP allowlist, the order, and the
 * file: `privacy-<UTC stamp>.json` = json.dumps({...}, indent=1, sort_keys=True), in data/raw itself (dir "").
 *
 * The extractor (main.ts) makes each request from Privacy's own page, with the headers the app's own request carried
 * (they stay in the page); everything here is testable without it. Nothing here logs a value: callers get counts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StandingRefusal } from '@dither-accounts/passkey';
import { py, sha256hex } from '@dither-accounts/statements-common';

const { PyInt, PyObj, PyFloat } = py;
type PyValue = py.PyValue;
type PyObjT = InstanceType<typeof PyObj>;

export const TXN_PATH = '/api/v2/transactions';
export const PAGE_SIZE = 100;
export const PASSES = 4;
export const NAME = /^privacy-\d{8}T\d{6}\.json$/;

// What a pull keeps of each transaction (pcom.py KEEP / KEEP_NESTED, verbatim). An allowlist: card expiry, IPs, auth
// codes, 3-D Secure tokens, risk scores and the funding account's balance never reach disk.
export const KEEP = new Set([
  'transactionUuid', 'transactionID', 'state', 'settlementStatus', 'statusDescription', 'accepted',
  'declineReason', 'hasBounced', 'amount', 'settledAmount', 'authorizationAmount', 'currency', 'currencyCode',
  'currencyRate', 'totalFees', 'isEstimatedFee', 'calculatedFees', 'dateAuthorized', 'dateSettled',
  'effectiveSettlementDate', 'descriptor', 'memo', 'mcc', 'mccCategory', 'city', 'geoState', 'country',
  'hostname', 'network', 'cardUuid', 'lastFour', 'cardType', 'cardState', 'achID', 'achSent', 'achReceived',
  'achResult', 'batchUuid', 'batchType', 'bankAccountUuid', 'fundingAccount', 'fundingBank', 'bankType',
  'originalAuth', 'refunds',
]);
/** null: the whole dict (Python's None); a set: only those keys. */
export const KEEP_NESTED = new Map<string, Set<string> | null>([
  ['mccCategory', new Set(['name'])],
  ['calculatedFees', null],
  ['originalAuth', new Set(['amount', 'date', 'result', 'type', 'uuid'])],
]);

/** pcom.py `_redact`. */
export function redact(t: PyObjT): PyObjT {
  const out = new PyObj();
  for (const [k, v0] of t.entries()) {
    if (!KEEP.has(k)) continue;
    let v = v0;
    if (v instanceof PyObj && KEEP_NESTED.has(k)) {
      const sub = KEEP_NESTED.get(k)!;
      v = new PyObj(v.entries().filter(([kk]) => sub === null || sub.has(kk)));
    } else if (k === 'refunds' && Array.isArray(v)) v = v.map((r) => (r instanceof PyObj ? redact(r) : r));
    out.set(k, v);
  }
  return out;
}

// ------------------------------------------------------------------ Python's str ordering and sort_keys
/** Python's comparison of two str: by code point (JavaScript's < compares UTF-16 units). */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
/** json.dumps(…, sort_keys=True): every dict's keys sorted, at every depth. */
export function sortKeys(v: PyValue): PyValue {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v instanceof PyObj) return new PyObj(v.entries().sort(([a], [b]) => cmpStr(a, b)).map(([k, e]) => [k, sortKeys(e)]));
  return v;
}

// ------------------------------------------------------------------ urllib.parse, as pcom.py used it
const unquotePlus = (s: string) => {
  const t = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
};
/** dict(parse_qsl(query)): blank values dropped, later duplicates win in the first one's place. */
export function parseQsl(q: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) continue;
    const v = part.slice(i + 1);
    if (!v.length) continue;
    out.set(unquotePlus(part.slice(0, i)), unquotePlus(v));
  }
  return out;
}
/** quote_plus(s, safe=''). */
export function quotePlus(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.~-]/.test(c)) out += c;
    else if (c === ' ') out += '+';
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
export const urlencode = (q: Map<string, string>) => [...q].map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');

/** Is this URL the app's transactions list (pcom.py `on_request`: host under privacy.com, path without a trailing /)? */
export function isTxnRequest(url: string, testHost?: string | null): boolean {
  try {
    const u = new URL(url);
    const hostOk = u.hostname.endsWith('privacy.com') || (!!testHost && u.hostname === testHost);
    return hostOk && u.pathname.replace(/\/+$/, '') === TXN_PATH;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the pull
export interface PullDeps {
  /** GET this URL from Privacy's page with the app's own headers: [status, body text]. */
  get: (url: string) => Promise<[number, string]>;
  log?: (msg: string) => void;
}
export interface Pulled {
  transactions: PyObjT[];
  total: PyValue;
  transactionFilter: string | null;
  requests: number;
  passes: number;
}

const num = (v: PyValue | undefined): number | null => (v instanceof PyInt ? v.toNumber() : v instanceof PyFloat ? v.value : null);

/**
 * pcom.py `pull`'s loop, from the app's own request URL (`captured`): offset pages of `pageSize`, until a pass has seen
 * as many distinct transactions as the server counts (at most four passes), keyed by transactionUuid, redacted.
 */
export async function pullTransactions(captured: string, deps: PullDeps, pageSize = PAGE_SIZE): Promise<Pulled> {
  const u = new URL(captured);
  const query = parseQsl(u.search.replace(/^\?/, ''));
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  const txns = new Map<string, PyObjT>();
  let total: PyValue | undefined; // undefined: Python's `total = None` before the first answer
  let requests = 0;
  let passes = 0;
  for (let attempt = 0; attempt < PASSES; attempt++) {
    passes++;
    let offset = 0;
    while (total === undefined || total === null || offset < (num(total) ?? Number.NaN)) {
      query.set('limit', String(pageSize));
      query.set('offset', String(offset));
      query.set('fullInfo', 'true');
      const url = `${base}?${urlencode(query)}`;
      const [status, text] = await deps.get(url);
      requests++;
      if (status < 200 || status > 299) throw new Error(`transactions request failed: HTTP ${status}`);
      let body: PyValue;
      try {
        body = py.parse(text);
      } catch {
        throw new Error('transactions request answered something that is not JSON');
      }
      if (!(body instanceof PyObj)) throw new Error('transactions answer is not an object');
      const d = body.get('data');
      const data: PyValue[] = py.truthy(d) ? (Array.isArray(d) ? d : []) : [];
      if (py.truthy(d) && !Array.isArray(d)) throw new Error('transactions answer: data is not a list');
      total = body.has('total') ? body.get('total')! : new PyInt(offset + data.length);
      for (const t of data) {
        if (!(t instanceof PyObj)) throw new Error('transactions answer: a row is not an object');
        const id = t.get('transactionUuid');
        if (typeof id !== 'string') throw new Error('transactions answer: a row has no transactionUuid');
        txns.set(id, redact(t));
      }
      offset += data.length;
      if (!data.length) break;
    }
    const n = num(total);
    if (n === null) throw new Error('transactions answer: total is not a number');
    deps.log?.(`pass ${attempt + 1}: ${txns.size}/${n} distinct`);
    if (txns.size >= n) break;
  }
  const key = (t: PyObjT) => {
    const d = t.get('dateAuthorized');
    if (py.truthy(d) && typeof d !== 'string') throw new Error('transactions answer: dateAuthorized is not a string');
    return [py.truthy(d) ? (d as string) : '', t.get('transactionUuid') as string] as const;
  };
  const sorted = [...txns.values()].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return cmpStr(x[0], y[0]) || cmpStr(x[1], y[1]);
  });
  return { transactions: sorted, total: total ?? null, transactionFilter: query.get('transactionFilter') ?? null, requests, passes };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}". */
export const stampUtc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** The file pcom.py wrote: its name, and json.dumps({...}, indent=1, sort_keys=True). */
export function privacyFile(p: Pick<Pulled, 'transactions' | 'total' | 'transactionFilter'>, now: Date, pulledAt = Math.floor(now.getTime() / 1000)): { name: string; text: string } {
  const doc = new PyObj([
    ['source', 'privacy.com'],
    ['endpoint', TXN_PATH],
    ['transactionFilter', p.transactionFilter],
    // pcom.py took int(time.time()) a moment after the name's stamp; the same second here.
    ['pulled_at', new PyInt(pulledAt)],
    ['total', p.total],
    ['transactions', p.transactions],
  ]);
  return { name: `privacy-${stampUtc(now)}.json`, text: py.dumps(sortKeys(doc), 1) };
}

// ------------------------------------------------------------------ state, and seeding it from data/raw
/** state.json: what the account knows from dither-finance's files (seed.ts) and its own pulls. No amounts. */
export interface PrivacyState {
  /** The newest privacy-*.json in dither-finance's raw tree when seeded: its name, sha256, counts, and per
   * transaction the first 16 hex of the sha256 of its dumps (to count same / changed / new / gone after a pull). */
  seed?: { file: string; sha256: string; total: number | null; transactions: number; transactionFilter: string | null; txn: Record<string, string> } | null;
  /** From data/privacy_discovery.json: the transactions requests the app made (method, path and query names). */
  discovery?: { endpoints: string[]; queryNames: string[][] } | null;
  /** The first pull after the seed, against it (counts only). */
  checked?: { at: number; file: string; same: number; changed: number; added: number; gone: number; transactionFilterSame: boolean } | null;
  /** Something only you can answer stopped a sign-in (an email code, a captcha, a password): every pull waits. */
  hold?: { what: string; message: string; since: number } | null;
  /** The approver's refusal that stops automatic sign-ins (packages/passkey signin.ts). */
  approval?: StandingRefusal | null;
  lastPull?: { at: number; file: string; transactions: number; requests: number; passes: number } | null;
}

/** Each transaction's uuid → the first 16 hex of the sha256 of json.dumps(it, sort_keys=True) (indent 1). */
export function txnDigest(txns: PyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of txns) {
    if (!(t instanceof PyObj)) continue;
    const id = t.get('transactionUuid');
    if (typeof id === 'string') out[id] = sha256hex(new TextEncoder().encode(py.dumps(sortKeys(t), 1))).slice(0, 16);
  }
  return out;
}

/** The newest privacy-*.json in a raw tree, as a seed (names, hashes, counts). */
export function seedFromRaw(rawDir: string): PrivacyState['seed'] {
  const names = readdirSync(rawDir).filter((n) => NAME.test(n)).sort();
  const file = names.at(-1);
  if (!file) return null;
  const bytes = readFileSync(join(rawDir, file));
  const doc = py.parse(bytes.toString('utf8'));
  const txns = (py.pyGet(doc, 'transactions') as PyValue[] | undefined) ?? [];
  const f = py.pyGet(doc, 'transactionFilter');
  return {
    file,
    sha256: sha256hex(bytes),
    total: num(py.pyGet(doc, 'total')),
    transactions: txns.length,
    transactionFilter: typeof f === 'string' ? f : null,
    txn: txnDigest(txns),
  };
}

/** The transactions requests in data/privacy_discovery.json (its keys are "METHOD host/path?name=…&…"; shapes only). */
export function discoveryFrom(text: string): PrivacyState['discovery'] {
  const d = JSON.parse(text) as Record<string, unknown>;
  const endpoints = Object.keys(d).filter((k) => {
    const m = /^GET [^/]+(\/[^?]*)/.exec(k);
    return !!m && m[1]!.replace(/\/+$/, '') === TXN_PATH;
  });
  return { endpoints, queryNames: endpoints.map((k) => (k.split('?')[1] ?? '').split('&').filter(Boolean).map((p) => p.split('=')[0]!)) };
}

/** After a pull: how its transactions compare with the seed's (counts only). */
export function compareWithSeed(seed: NonNullable<PrivacyState['seed']>, pulled: Pulled, file: string, now: number): NonNullable<PrivacyState['checked']> {
  const mine = txnDigest(pulled.transactions);
  let same = 0;
  let changed = 0;
  let added = 0;
  for (const [id, h] of Object.entries(mine)) {
    if (!(id in seed.txn)) added++;
    else if (seed.txn[id] === h) same++;
    else changed++;
  }
  const gone = Object.keys(seed.txn).filter((id) => !(id in mine)).length;
  return { at: now, file, same, changed, added, gone, transactionFilterSame: seed.transactionFilter === pulled.transactionFilter };
}
