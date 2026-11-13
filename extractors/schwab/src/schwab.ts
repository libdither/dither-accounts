/**
 * The schwab kind's pure half (docs/schwab.md): which pages are which, what a downloaded file is, what it is named for
 * dither-finance, and which ranges a pull asks Schwab for. Tested in test/schwab.test.ts.
 *
 * Schwab's web pages export CSV (History: brokerage and bank; Realized Gain/Loss), not the printed pages
 * dither-finance used to take: those CSVs are what this kind hands over, in `schwab/`, named
 * `schwab-<layout>-<mask>[-<from>-<to>]-<UTC stamp>.<ext>` (dither-finance's ledger/parsers/schwab_csv.py reads the
 * layout, the account's last three digits and the range asked for from the name). A page printed to PDF and saved in
 * the live view's Downloads goes over as `schwab-print-<stamp>.pdf` (dither-finance's PDF parsers read those).
 */
import { refusalMessage, refusalNote, type StandingRefusal } from '@dither-accounts/passkey';

export type Layout = 'brokerage' | 'bank' | 'realized';
export type PageKind = 'none' | 'signin' | 'challenge' | 'app' | 'site' | 'other';

/** Paths that are about signing in or out on schwab.com's own hosts. */
// Not `access`: Schwab's sign-in is /Areas/Access/Login (login says it), and its signed-in security settings, where the
// passkey is added, are /retail/access/securitysettings/.
const SIGN_IN = /(^|\/)(login|signon|sign-on|signin|logon|logout|logoff|mfa|otp|verify|challenge|auth)(\/|$)/i;

/**
 * What a tab is on, from its origin and path (the driver never reports a query or a hash). Signed in means
 * client.schwab.com on a page that is not a sign-in page; www.schwab.com and the sws-gateway sign-in hosts are signing in.
 * The probe (page.js) refines `signin` to `challenge` when the page asks for a code.
 */
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
  if (u.hostname === site || u.hostname.endsWith(`.${site}`)) return u.hostname.startsWith('www.') || u.hostname.includes('gateway') || SIGN_IN.test(u.pathname) ? 'signin' : 'site';
  return 'other';
}

// ---------------------------------------------------------------- what a file is

/** Header spellings per column, as schwab_csv.py has them (compared case-insensitively, spaces squeezed). */
const COLS: Record<Layout, Record<string, string[]>> = {
  brokerage: { date: ['Date'], type: ['Action', 'Transaction', 'Type'], description: ['Description'], quantity: ['Quantity', 'Qty'], amount: ['Amount'] },
  bank: { date: ['Date'], description: ['Description'], withdrawal: ['Withdrawal', 'Withdrawal (-)', 'Withdrawals'], deposit: ['Deposit', 'Deposit (+)', 'Deposits'], balance: ['RunningBalance', 'Running Balance', 'Balance', 'Status'] },
  realized: { symbol: ['Symbol'], closed: ['Closed Date', 'Date Closed'], quantity: ['Quantity', 'Qty'], proceeds: ['Proceeds'], cost: ['Cost Basis (CB)', 'Cost Basis', 'Cost Basis ($)'] },
};
const norm = (s: string) => s.replace(/﻿/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** RFC 4180 rows (quoted fields, doubled quotes, newlines inside quotes, CRLF or LF). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

export interface Recognized {
  layout: Layout;
  ext: 'csv' | 'json';
  /** The account's last three digits, from the file's own name or title, when it says. */
  mask: string | null;
  /** Data rows (not the header, totals or notes). */
  rows: number;
  /** The first and last day of the rows (YYYY-MM-DD), when they have dates. */
  span: [string, string] | null;
}

const DATE = /^\s*(\d\d)\/(\d\d)\/(\d{4})(?:\s+as of\s+\d\d\/\d\d\/\d{4})?\s*$/;
const isoOf = (m: RegExpExecArray) => `${m[3]}-${m[1]}-${m[2]}`;

/** The account's last three digits in a Schwab file name or title: Checking_XXX222_…, "…222", "XXXX-9222". */
export function maskIn(s: string): string | null {
  const m = /(?:^|_)X{2,}-?(\d{3,})(?:_|-|\.|$)/.exec(s) ?? /…\s?(\d{3,4})\b/.exec(s) ?? /\.\.\.(\d{3,4})\b/.exec(s) ?? /\bX{2,}-?(\d{3,4})\b/.exec(s) ?? /\b\d{4}-(\d{4})\b/.exec(s);
  return m ? m[1].slice(-3) : null;
}

/** A Schwab export (CSV, or History's JSON) by its header; null for anything else. */
export function recognize(bytes: Uint8Array, fileName = ''): Recognized | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4 << 20)).replace(/^﻿/, '');
  const head = text.trimStart();
  if (head.startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      if (!Array.isArray(doc?.BrokerageTransactions)) return null;
      const days = doc.BrokerageTransactions.map((t: any) => DATE.exec(String(t?.Date ?? ''))).filter(Boolean).map((m: RegExpExecArray) => isoOf(m)).sort();
      return { layout: 'brokerage', ext: 'json', mask: maskIn(fileName), rows: doc.BrokerageTransactions.length, span: days.length ? [days[0], days.at(-1)] : null };
    } catch {
      return null;
    }
  }
  const rows = csvRows(text);
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const have = new Map(rows[i].map((c, j) => [norm(c), j]));
    for (const layout of ['realized', 'bank', 'brokerage'] as Layout[]) {
      const cols = COLS[layout];
      const idx: Record<string, number> = {};
      for (const [k, names] of Object.entries(cols)) {
        const j = names.map(norm).find((n) => have.has(n));
        if (j !== undefined) idx[k] = have.get(j)!;
      }
      if (Object.keys(idx).length !== Object.keys(cols).length) continue;
      const dateCol = layout === 'realized' ? idx.closed : idx.date;
      const days: string[] = [];
      let n = 0;
      for (const r of rows.slice(i + 1)) {
        const m = DATE.exec(r[dateCol] ?? '');
        if (!m) continue;
        n++;
        days.push(isoOf(m));
      }
      days.sort();
      const title = rows.slice(0, i).map((r) => r.join(' ')).join(' ');
      return { layout, ext: 'csv', mask: maskIn(fileName) ?? maskIn(title), rows: n, span: days.length ? [days[0], days.at(-1)!] : null };
    }
  }
  return null;
}

export const isPdf = (bytes: Uint8Array) => bytes.length > 4 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';

/** YYYYMMDDTHHMMSSZ, as dither-finance's stamps. */
export const stampUtc = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const compact = (d: string) => d.replaceAll('-', '');

/** dither-finance's name for an export (schwab_csv.py OUR_NAME). The range goes in only when the file kept to it. */
export function fileName(layout: Layout, mask: string, ext: 'csv' | 'json', at: number, range?: { from: string; to: string } | null): string {
  if (!/^\d{3}$/.test(mask)) throw new Error('a mask is three digits');
  return `schwab-${layout}-${mask}${range ? `-${compact(range.from)}-${compact(range.to)}` : ''}-${stampUtc(at)}.${ext}`;
}
export const printName = (at: number) => `schwab-print-${stampUtc(at)}.pdf`;

/** Whether the rows kept inside the range asked for (Schwab may ignore a range it does not take). */
export const keptTo = (r: Recognized, range: { from: string; to: string }) => !r.span || (r.span[0] >= range.from && r.span[1] <= range.to);

// ---------------------------------------------------------------- ranges

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** mm/dd/yyyy, as Schwab's date fields take it. */
export const us = (isoDay: string) => `${isoDay.slice(5, 7)}/${isoDay.slice(8, 10)}/${isoDay.slice(0, 4)}`;

/**
 * The range a page says it shows ("Transactions found from 05/10/2026 to 11/10/2026"), as ISO days, or null. Schwab's
 * History shows the last 6 months by default, which covers a daily pull when the date picker cannot be set.
 */
export function shownRange(text: string): Range | null {
  const m = /\bfrom\s+(\d{2})\/(\d{2})\/(\d{4})\s+to\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  return m ? { from: `${m[3]}-${m[1]}-${m[2]}`, to: `${m[6]}-${m[4]}-${m[5]}` } : null;
}

export interface Range {
  from: string;
  to: string;
}

/**
 * History ranges for one account: the first of last month to today; when backfilling, whole years back from this one
 * to `since` (oldest last), this year to today. Realized Gain/Loss: this year to today, and when backfilling the
 * same whole years. Newest first, so a backfill that stops early still has the recent rows.
 */
export function historyRanges(today: Date, backfill: { since: number } | null): Range[] {
  const t = iso(today);
  if (!backfill) return [{ from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: t }];
  const out: Range[] = [];
  for (let y = today.getFullYear(); y >= backfill.since; y--) out.push({ from: `${y}-01-01`, to: y === today.getFullYear() ? t : `${y}-12-31` });
  return out;
}
export function realizedRanges(today: Date, backfill: { since: number } | null): Range[] {
  return backfill ? historyRanges(today, backfill) : [{ from: `${today.getFullYear()}-01-01`, to: iso(today) }];
}

// ---------------------------------------------------------------- state

/** Schwab asked for something only you can give after the passkey answered: every pull waits until you are in. */
export interface Hold {
  what: 'code' | 'captcha';
  message: string;
  since: number;
}

export interface SchwabState {
  /** Accounts the History page lists: mask → its label as the page shows it (a nickname and …222). */
  accounts: Record<string, { label: string; history: boolean; realized: boolean; kind?: string }>;
  /** sha256 → name of every file handed over (the newest 400), so the same bytes go over once. */
  seen: Record<string, string>;
  /** Backfilled, per mask and page ("history:222"). */
  backfilled: Record<string, boolean>;
  lastSignedInPull?: number;
  hold?: Hold | null;
  /** The approver's refusal that stops automatic sign-ins (packages/passkey signin.ts). */
  approval?: StandingRefusal | null;
}

export function remember(st: SchwabState, sha: string, name: string) {
  st.seen[sha] = name;
  const keys = Object.keys(st.seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete st.seen[k];
}

// ---------------------------------------------------------------- status

export const SIGN_IN_MESSAGE = 'Sign in to Schwab in the live view, as on your desktop (password, then the code Schwab sends). Next you add a passkey for this browser; the first pull starts by itself once you are in.';
export const ADD_PASSKEY_MESSAGE =
  "Signed in. Now add a passkey for this browser: in Schwab's Security Center (Login & security settings, or similar) find Passkeys and add one. This browser answers the passkey prompt itself (no phone, no QR code, no security key).";
export const CHECK_MESSAGE = 'Passkey added. Check that it works: log out of Schwab in the live view, then log in again and choose the passkey option.';
export const CHECK_SIGNED_OUT_MESSAGE = 'Passkey added. Check that it works: log in to Schwab in the live view and choose the passkey option.';
export const CHALLENGE_MESSAGE = "Schwab is asking you to confirm it's you (a code or an approval): answer it in the live view. Nothing here answers it.";
export const CAPTCHA_MESSAGE = 'Schwab shows a captcha: solve it in the live view and log in there (pulls wait until Schwab is signed in again).';
export const autoFailedMessage = (why: string) => `Signing in to Schwab with the passkey did not work (${why}): open the live view and log in, choosing the passkey option.`;
/** The signed-in layer's note while signed out with a working passkey. */
export const SIGNS_ITSELF_IN = 'signed out for now: the passkey signs in by itself before each pull';

/** The passkey's non-secret facts (packages/passkey summary()). */
export interface PasskeyFacts {
  enrolled: boolean;
  count: number;
  newest: { idPrefix: string; rpId: string; algorithm: string; createdAt: number; lastUsedAt: number | null; verifiedAt: number | null } | null;
}

/** Signing in by itself with the passkey. */
export interface AutoSignIn {
  /** A sign-in is running now. */
  signingIn: boolean;
  /** Schwab asked for something only you can give: every pull waits until it is signed in again. */
  hold: Hold | null;
  /** The last automatic sign-in gave up after its tries (cleared once signed in). */
  failed: string | null;
  lastOkAt: number | null;
  /** The paired phone refused: no automatic sign-in until a pull you start (or, if it expired, the next scheduled pull). */
  approval?: StandingRefusal | null;
}

export interface View {
  signedIn: boolean;
  /** The page asks for a code or an approval (the probe saw it). */
  challenge: boolean;
  lastSignedInPull: number | null;
  now: number;
  passkey: PasskeyFacts;
  auto: AutoSignIn;
  /** The last request the authenticator refused, why (no secrets). */
  lastRefusal?: string | null;
}

type Attention = { kind: string; message: string; liveView: boolean };
const att = (kind: string, message: string) => ({ status: 'attention', attention: { kind, message, liveView: true } as Attention });

/**
 * The three steps, as Privacy's (docs/schwab.md): sign in in the live view (`login`), add a passkey in Schwab's
 * security settings (`passkey`), log out and back in with it (`passkey_check`). After that a signed-out Schwab is not
 * your problem: the passkey signs in by itself before each pull, and you are asked (`login`) only when that fails three
 * times or Schwab asks for a code, an approval or a captcha. While the page itself shows a code being asked for, that
 * is `verify`, as before.
 */
export function state(v: View): { status: string; attention: Attention | null } {
  if (v.challenge) return att('verify', CHALLENGE_MESSAGE);
  const p = v.passkey;
  const checked = !!p.newest?.verifiedAt;
  if (v.signedIn) {
    if (!p.enrolled) return att('passkey', ADD_PASSKEY_MESSAGE);
    if (!checked) return att('passkey_check', CHECK_MESSAGE);
    return { status: 'online', attention: null };
  }
  if (checked) {
    if (v.auto.hold) return att('login', v.auto.hold.message);
    if (v.auto.approval) return att('approval', refusalMessage('Schwab', v.auto.approval));
    if (v.auto.failed) return att('login', autoFailedMessage(v.auto.failed));
    return { status: 'online', attention: null };
  }
  if (p.enrolled) return att('passkey_check', CHECK_SIGNED_OUT_MESSAGE);
  return att('login', SIGN_IN_MESSAGE);
}

type Layer = { name: string; state: 'ok' | 'waiting' | 'failed'; note: string };
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const minute = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function signedInLayer(v: View): Layer {
  const checked = !!v.passkey.newest?.verifiedAt;
  if (v.challenge) return { name: 'signed in', state: 'waiting', note: 'Schwab is asking for a code or an approval in the live view' };
  if (v.signedIn) return { name: 'signed in', state: 'ok', note: 'on client.schwab.com' };
  if (checked && v.auto.hold) return { name: 'signed in', state: 'failed', note: `held: Schwab asks for ${v.auto.hold.what === 'captcha' ? 'a captcha' : 'a code or an approval'}; log in in the live view` };
  if (checked && v.auto.approval) return { name: 'signed in', state: 'failed', note: `the passkey sign-in stopped: ${refusalNote(v.auto.approval)}` };
  if (checked && v.auto.failed) return { name: 'signed in', state: 'failed', note: `the passkey sign-in failed: ${v.auto.failed}` };
  if (checked) return { name: 'signed in', state: v.auto.signingIn ? 'waiting' : 'ok', note: v.auto.signingIn ? 'signing in with the passkey' : SIGNS_ITSELF_IN };
  return { name: 'signed in', state: 'waiting', note: 'sign in in the live view; the pull follows by itself' };
}

/** passkey → passkey sign-in, as Privacy's. */
export function passkeyLayers(v: View): Layer[] {
  const n = v.passkey.newest;
  const passkey: Layer = n
    ? { name: 'passkey', state: 'ok', note: `${n.algorithm} passkey ${n.idPrefix}… for ${n.rpId}, added ${day(n.createdAt)}${v.passkey.count > 1 ? ` (${v.passkey.count} held)` : ''}` }
    : { name: 'passkey', state: 'waiting', note: v.lastRefusal ? `none yet; last request refused: ${v.lastRefusal}` : "none yet: add one in Schwab's security settings once signed in" };
  const check: Layer = n?.verifiedAt
    ? { name: 'passkey sign-in', state: 'ok', note: `signed in with it ${minute(n.verifiedAt)}${n.lastUsedAt ? `; last used ${minute(n.lastUsedAt)}` : ''}` }
    : n
      ? { name: 'passkey sign-in', state: 'waiting', note: n.lastUsedAt ? `used ${minute(n.lastUsedAt)}, but no sign-in with it was seen to finish yet` : 'log out and back in with the passkey to check it' }
      : { name: 'passkey sign-in', state: 'waiting', note: 'waits for a passkey' };
  return [passkey, check];
}

/** The passkey's details for the status: names, ids' first characters, days and counts only. */
export function passkeyDetails(v: View): Record<string, string | number | boolean | null> {
  const n = v.passkey.newest;
  return {
    passkeyEnrolled: v.passkey.enrolled,
    passkeys: v.passkey.count,
    credentialIdPrefix: n ? `${n.idPrefix}…` : null,
    passkeyAlgorithm: n?.algorithm ?? null,
    passkeyRpId: n?.rpId ?? null,
    passkeyCreated: n ? day(n.createdAt) : null,
    passkeyLastUsed: n?.lastUsedAt ? minute(n.lastUsedAt) : null,
    passkeySignInChecked: n?.verifiedAt ? minute(n.verifiedAt) : null,
    lastRefusal: v.lastRefusal ?? null,
    autoSignIn: v.auto.hold
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
    lastAutoSignIn: v.auto.lastOkAt ? minute(v.auto.lastOkAt) : null,
  };
}

/** What a sign-in page asks for that only you can give, from the probe of every frame (booleans only). */
export function challengeOf(p: { otp: boolean; challenge: boolean; captcha: boolean }, afterPasskey: boolean): Hold['what'] | null {
  if (p.captcha) return 'captcha';
  // Before the passkey: only a code field (the sign-in page's own words may mention codes). After it: words too.
  if (afterPasskey ? p.challenge || p.otp : p.otp) return 'code';
  return null;
}
export const holdMessage = (what: Hold['what']) => (what === 'captcha' ? CAPTCHA_MESSAGE : CHALLENGE_MESSAGE);
